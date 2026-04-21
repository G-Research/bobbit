// ============================================================================
// FULL SEARCH PAGE — #/search route
// ============================================================================

import { html, nothing, type TemplateResult } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { ArrowLeft, Search, Loader2, Archive, ChevronRight, Goal as GoalIcon, MessagesSquare, MessageSquare, Bot } from "lucide";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { searchApi } from "./api.js";
import { renderApp } from "./state.js";
import { setHashRoute, getRouteFromHash } from "./routing.js";
import { connectToSession } from "./session-manager.js";
import "./components/search-status-dot.js";

// ============================================================================
// TYPES
// ============================================================================

export interface SearchResultItem {
	type: string;
	id: string;
	title: string;
	snippet: string;
	timestamp: number;
	archived: boolean;
	goalId?: string;
	sessionId?: string;
	sessionTitle?: string;
	projectId?: string;
	score?: number;
	matchedOn?: "text" | "metadata";
}

/** A collapsible group keyed by its parent entity (goal/session/staff). */
export interface ResultGroup {
	key: string;                  // "goal:<id>" | "session:<id>" | "staff:<id>"
	kind: "goal" | "session" | "staff";
	parent: SearchResultItem | null;
	parentFallback?: {
		id: string;
		title: string;
		archived: boolean;
		timestamp: number;
		projectId?: string;
	};
	children: SearchResultItem[];
	matchCount: { title: number; messages: number };
	bestScore: number;
	latestTs: number;
}

// ============================================================================
// MODULE-LEVEL STATE
// ============================================================================

let _query = "";
let _results: SearchResultItem[] = [];
let _loading = false;
let _typeFilters = new Set(["goals", "sessions", "staff", "messages"]);
let _offset = 0;
let _total = 0;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _initialized = false;
let _expanded = new Set<string>();
let _staleIds = new Set<string>();
let _staleToast: { kind: string; id: string; at: number } | null = null;
let _staleToastTimer: ReturnType<typeof setTimeout> | null = null;
let _staleListenerBound = false;

// ============================================================================
// SEARCH LOGIC
// ============================================================================

async function _doSearch(append = false): Promise<void> {
	if (!_query.trim()) {
		_results = [];
		_total = 0;
		_loading = false;
		if (!append) _expanded.clear();
		renderApp();
		return;
	}
	_loading = true;
	if (!append) _expanded.clear();
	renderApp();
	const querySnapshot = _query;
	try {
		const data = await searchApi(_query, "all", 50, append ? _offset : 0);
		if (_query !== querySnapshot) return; // discard stale response
		if (!append) {
			_results = data.results as SearchResultItem[];
			_offset = data.results.length;
		} else {
			_results = [..._results, ...(data.results as SearchResultItem[])];
			_offset += data.results.length;
		}
		_total = data.total;
	} catch (err) {
		console.error("[search-page] Search failed:", err);
	}
	_loading = false;
	renderApp();
}

function _handleInput(e: Event): void {
	_query = (e.target as HTMLInputElement).value;
	if (_debounceTimer) clearTimeout(_debounceTimer);
	_debounceTimer = setTimeout(() => {
		_offset = 0;
		_doSearch();
		// Update URL without navigation
		const newHash = _query ? `#/search?q=${encodeURIComponent(_query)}` : "#/search";
		if (window.location.hash !== newHash) {
			history.replaceState({}, "", newHash);
		}
	}, 200);
	renderApp();
}

function _handleKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") {
		if (_query) {
			_query = "";
			_results = [];
			_total = 0;
			_offset = 0;
			_expanded.clear();
			renderApp();
		} else {
			_initialized = false;
			history.back();
		}
	}
}

function _toggleFilter(type: string): void {
	if (_typeFilters.has(type)) {
		// Don't allow deselecting all
		if (_typeFilters.size > 1) {
			_typeFilters.delete(type);
		}
	} else {
		_typeFilters.add(type);
	}
	renderApp();
}

function _loadMore(): void {
	_doSearch(true);
}

// ============================================================================
// STALE-RESULT TOAST
// ============================================================================

function _ensureStaleListener(): void {
	if (_staleListenerBound || typeof window === "undefined") return;
	_staleListenerBound = true;
	window.addEventListener("search-result-stale", (e: Event) => {
		const detail = (e as CustomEvent).detail as { kind?: string; id?: string } | undefined;
		if (!detail?.id) return;
		_staleIds.add(detail.id);
		_staleToast = { kind: detail.kind || "result", id: detail.id, at: Date.now() };
		if (_staleToastTimer) clearTimeout(_staleToastTimer);
		_staleToastTimer = setTimeout(() => {
			_staleToast = null;
			_staleToastTimer = null;
			renderApp();
		}, 5000);
		renderApp();
	});
}

function _dismissToast(): void {
	if (_staleToastTimer) { clearTimeout(_staleToastTimer); _staleToastTimer = null; }
	_staleToast = null;
	renderApp();
}

// ============================================================================
// RESULT CLICK HANDLERS
// ============================================================================

function _handleResultClick(result: SearchResultItem): void {
	// Clear any visible stale toast — user has moved on.
	if (_staleToast) _dismissToast();

	if (result.type === "goal") {
		setHashRoute("goal-dashboard", result.id);
	} else if (result.type === "session") {
		connectToSession(result.id, true, { onMissing: "toast" });
	} else if (result.type === "staff") {
		setHashRoute("staff-edit", result.id);
	} else if (result.type === "message" && result.sessionId) {
		connectToSession(result.sessionId, true, { onMissing: "toast" });
	}
}

// ============================================================================
// GROUPING
// ============================================================================

/**
 * Group a flat list of search results by parent entity.
 * - Staff: always standalone.
 * - Goal title-hit: its own goal card (messages/sessions do NOT nest inside it here — flat top-level to keep renderer simple).
 * - Session: session card (with message children nested under it).
 * - Message: nested under its session card (creates a parent-less session group if no direct session hit).
 */
export function buildGroups(filtered: SearchResultItem[]): ResultGroup[] {
	const groups = new Map<string, ResultGroup>();

	const ensureGroup = (key: string, kind: ResultGroup["kind"]): ResultGroup => {
		let g = groups.get(key);
		if (!g) {
			g = {
				key,
				kind,
				parent: null,
				children: [],
				matchCount: { title: 0, messages: 0 },
				bestScore: 0,
				latestTs: 0,
			};
			groups.set(key, g);
		}
		return g;
	};

	for (const hit of filtered) {
		switch (hit.type) {
			case "staff": {
				const key = `staff:${hit.id}`;
				const g = ensureGroup(key, "staff");
				g.parent = hit;
				g.matchCount.title++;
				g.bestScore = Math.max(g.bestScore, hit.score ?? 0);
				g.latestTs = Math.max(g.latestTs, hit.timestamp ?? 0);
				break;
			}
			case "goal": {
				const key = `goal:${hit.id}`;
				const g = ensureGroup(key, "goal");
				g.parent = hit;
				g.matchCount.title++;
				g.bestScore = Math.max(g.bestScore, hit.score ?? 0);
				g.latestTs = Math.max(g.latestTs, hit.timestamp ?? 0);
				break;
			}
			case "session": {
				const key = `session:${hit.id}`;
				const g = ensureGroup(key, "session");
				g.parent = hit;
				g.matchCount.title++;
				g.bestScore = Math.max(g.bestScore, hit.score ?? 0);
				g.latestTs = Math.max(g.latestTs, hit.timestamp ?? 0);
				break;
			}
			case "message": {
				if (!hit.sessionId) continue;
				const key = `session:${hit.sessionId}`;
				const g = ensureGroup(key, "session");
				if (!g.parent && !g.parentFallback) {
					g.parentFallback = {
						id: hit.sessionId,
						title: hit.sessionTitle ?? "Untitled session",
						archived: hit.archived ?? false,
						timestamp: hit.timestamp ?? 0,
						projectId: hit.projectId,
					};
				}
				g.children.push(hit);
				g.matchCount.messages++;
				g.bestScore = Math.max(g.bestScore, hit.score ?? 0);
				g.latestTs = Math.max(g.latestTs, hit.timestamp ?? 0);
				break;
			}
			default:
				// Unknown types fall through — render as a standalone entry keyed by type+id.
				{
					const key = `${hit.type}:${hit.id}`;
					const g = ensureGroup(key, "session");
					g.parent = hit;
					g.matchCount.title++;
				}
				break;
		}
	}

	return Array.from(groups.values()).sort((a, b) => {
		if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
		return b.latestTs - a.latestTs;
	});
}

// ============================================================================
// HELPERS
// ============================================================================

/** Turn a timestamp into a terse relative string (e.g. "2h", "3d"). */
function _relativeTime(ts: number): string {
	if (!ts) return "";
	const diff = Math.max(0, Date.now() - ts);
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	const months = Math.floor(days / 30);
	return `${months}mo`;
}

/**
 * Sanitize FTS5 snippet output — only allow <b> tags for match highlighting.
 */
function _sanitizeSnippet(raw: string): string {
	return raw
		.replace(/<b>/gi, "\x00B")
		.replace(/<\/b>/gi, "\x00E")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\x00B/g, "<b>")
		.replace(/\x00E/g, "</b>");
}

function _capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function _iconForType(type: string) {
	switch (type) {
		case "goals":
		case "goal":
			return GoalIcon;
		case "sessions":
		case "session":
			return MessagesSquare;
		case "staff":
			return Bot;
		case "messages":
		case "message":
			return MessageSquare;
		default:
			return Search;
	}
}

// ============================================================================
// INIT
// ============================================================================

export function initSearchPage(): void {
	_ensureStaleListener();
	if (_initialized) return;
	const route = getRouteFromHash();
	_query = route.searchQuery || "";
	_offset = 0;
	_initialized = true;
	_expanded.clear();
	_staleIds.clear();
	if (_query) {
		_doSearch();
	} else {
		_results = [];
		_total = 0;
		_loading = false;
	}
}

/** Reset init flag so the next initSearchPage() reads the URL again (called on hashchange away). */
export function resetSearchPage(): void {
	_initialized = false;
}


// ============================================================================
// RENDER — child (nested) rows
// ============================================================================

function _renderChildRow(result: SearchResultItem) {
	const title = result.type === "message"
		? (result.sessionTitle || result.title)
		: result.title;
	const isStale = _staleIds.has(result.id) || (result.sessionId ? _staleIds.has(result.sessionId) : false);

	return html`
		<button
			data-role="result-child"
			data-type=${result.type}
			data-id=${result.id}
			class="w-full text-left px-3 py-2 rounded-md hover:bg-accent/40 transition-colors cursor-pointer flex flex-col gap-1 ${isStale ? "opacity-50" : ""}"
			@click=${(e: Event) => { e.stopPropagation(); _handleResultClick(result); }}
		>
			<div class="flex items-center gap-2 min-w-0">
				${icon(_iconForType(result.type) as Parameters<typeof icon>[0], "xs")}
				<span class="truncate text-xs text-foreground">${title || "Untitled"}</span>
				${isStale ? html`
					<span class="shrink-0 text-[10px] text-muted-foreground italic">stale</span>
				` : ""}
				<span class="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
					${_relativeTime(result.timestamp)}
				</span>
			</div>
			${result.snippet ? html`
				<div class="text-xs text-muted-foreground line-clamp-2 leading-relaxed search-snippet pl-5">
					${unsafeHTML(_sanitizeSnippet(result.snippet))}
				</div>
			` : ""}
		</button>
	`;
}

// ============================================================================
// RENDER — group card
// ============================================================================

function _renderMatchPill(mc: { title: number; messages: number }): TemplateResult | typeof nothing {
	const total = mc.title + mc.messages;
	if (total === 0) return nothing;
	const label = (mc.title > 0 && mc.messages > 0)
		? `${mc.title} in title · ${mc.messages} in messages`
		: total === 1 ? "1 match" : `${total} matches`;
	return html`
		<span class="shrink-0 inline-flex items-center px-1.5 py-0 rounded text-[10px] bg-primary/10 text-primary">
			${label}
		</span>
	`;
}

function _collapsedSnippetFragments(group: ResultGroup): TemplateResult[] {
	const frags: TemplateResult[] = [];
	const pushFrag = (html_: string) => {
		frags.push(html`
			<div class="text-xs text-muted-foreground line-clamp-1 leading-relaxed search-snippet">
				${unsafeHTML(_sanitizeSnippet(html_))}
			</div>
		`);
	};
	const parentMatchedText = group.parent?.matchedOn !== "metadata" && group.parent?.snippet;
	if (parentMatchedText) pushFrag(group.parent!.snippet);
	if (frags.length < 2 && group.children.length > 0) {
		const first = group.children.find(c => c.snippet);
		if (first?.snippet) pushFrag(first.snippet);
	}
	if (frags.length < 2 && group.children.length > 1) {
		const second = group.children.slice(1).find(c => c.snippet);
		if (second?.snippet) pushFrag(second.snippet);
	}
	return frags.slice(0, 2);
}

function _renderGroupCard(group: ResultGroup) {
	const parent = group.parent;
	const fallback = group.parentFallback;
	const id = parent?.id ?? fallback?.id ?? group.key;
	const title = parent?.title || fallback?.title || "Untitled";
	const archived = parent?.archived ?? fallback?.archived ?? false;
	const timestamp = parent?.timestamp ?? fallback?.timestamp ?? 0;
	const isStale = _staleIds.has(id);
	const totalMatches = group.matchCount.title + group.matchCount.messages;
	const autoExpanded = totalMatches === 1;
	const userExpanded = _expanded.has(group.key);
	const expanded = autoExpanded !== userExpanded; // XOR: autoExpand starts expanded, toggle collapses it
	const canExpand = group.children.length > 0;
	const lucideIcon = _iconForType(group.kind);

	const onHeaderClick = () => {
		if (parent) {
			_handleResultClick(parent);
		} else if (fallback) {
			// Parent-less group (messages-only) — navigate to the session.
			_handleResultClick({
				type: "session",
				id: fallback.id,
				title: fallback.title,
				snippet: "",
				timestamp: fallback.timestamp,
				archived: fallback.archived,
				projectId: fallback.projectId,
			});
		}
	};

	const onChevronClick = (e: Event) => {
		e.stopPropagation();
		// autoExpanded groups start "expanded"; toggling adds them to _expanded to flip to collapsed.
		// non-auto groups add to _expanded to flip to expanded.
		if (_expanded.has(group.key)) _expanded.delete(group.key);
		else _expanded.add(group.key);
		renderApp();
	};

	const fragments = expanded ? [] : _collapsedSnippetFragments(group);
	const metadataOnly = parent?.matchedOn === "metadata" && fragments.length === 0;

	return html`
		<div
			data-role="result-group"
			data-kind=${group.kind}
			data-key=${group.key}
			data-expanded=${expanded ? "true" : "false"}
			class="rounded-lg border border-border/50 bg-background/40 overflow-hidden ${isStale ? "opacity-60" : ""}"
		>
			<div class="flex items-stretch">
				<button
					class="flex-1 min-w-0 text-left px-3 py-2.5 hover:bg-accent/50 transition-colors cursor-pointer flex flex-col gap-1"
					@click=${onHeaderClick}
				>
					<div class="flex items-center gap-2 min-w-0">
						<span class="shrink-0 text-muted-foreground">
							${icon(lucideIcon as Parameters<typeof icon>[0], "sm")}
						</span>
						<span class="truncate font-medium text-foreground text-sm">${title || "Untitled"}</span>
						${archived ? html`
							<span class="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[10px] bg-muted text-muted-foreground">
								${icon(Archive, "xs")} archived
							</span>
						` : ""}
						${isStale ? html`
							<span class="shrink-0 text-[10px] text-muted-foreground italic">stale</span>
						` : ""}
						${_renderMatchPill(group.matchCount)}
						<span class="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
							${_relativeTime(timestamp)}
						</span>
					</div>
					${metadataOnly ? html`
						<div class="text-xs text-muted-foreground/70 italic pl-6">matched on title/metadata</div>
					` : fragments.length > 0 ? html`
						<div class="flex flex-col gap-0.5 pl-6">${fragments}</div>
					` : ""}
				</button>
				${canExpand ? html`
					<button
						data-role="group-chevron"
						aria-expanded=${expanded ? "true" : "false"}
						aria-label=${expanded ? "Collapse group" : "Expand group"}
						class="shrink-0 px-2 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/60 border-l border-border/50 transition-colors"
						@click=${onChevronClick}
					>
						<span class="inline-block transition-transform ${expanded ? "rotate-90" : ""}">
							${icon(ChevronRight, "sm")}
						</span>
					</button>
				` : ""}
			</div>
			${expanded ? html`
				<div class="border-t border-border/50 bg-muted/20 px-2 py-2 flex flex-col gap-1">
					${parent?.snippet && parent.matchedOn !== "metadata" ? html`
						<div class="text-xs text-muted-foreground leading-relaxed search-snippet px-3 py-1">
							${unsafeHTML(_sanitizeSnippet(parent.snippet))}
						</div>
					` : parent?.matchedOn === "metadata" ? html`
						<div class="text-xs text-muted-foreground/70 italic px-3 py-1">matched on title/metadata</div>
					` : ""}
					${group.children.length > 0 ? html`
						<div class="flex flex-col gap-0.5 border-l-2 border-border/50 ml-2 pl-1">
							${group.children.map(c => _renderChildRow(c))}
						</div>
					` : ""}
				</div>
			` : ""}
		</div>
	`;
}

// ============================================================================
// RENDER — results list
// ============================================================================

function _renderResults(): TemplateResult | typeof nothing {
	// Loading state (no results yet)
	if (_loading && _results.length === 0) {
		return html`
			<div class="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
				<span class="inline-block animate-spin">${icon(Loader2, "sm")}</span>
				Searching…
			</div>
		`;
	}

	// Empty state
	if (!_loading && _query && _results.length === 0) {
		return html`
			<div class="flex flex-col items-center justify-center py-12 text-muted-foreground text-sm gap-1">
				<span>No matches for "${_query}"</span>
			</div>
		`;
	}

	// No query yet
	if (!_query) {
		return html`
			<div class="flex flex-col items-center justify-center py-12 text-muted-foreground text-sm gap-2">
				${icon(Search, "lg")}
				<span>Search across goals, sessions, staff, and messages</span>
			</div>
		`;
	}

	// Filter results by active type filters (BEFORE grouping per design).
	const filtered = _results.filter(r => {
		if (r.type === "goal") return _typeFilters.has("goals");
		if (r.type === "session") return _typeFilters.has("sessions");
		if (r.type === "staff") return _typeFilters.has("staff");
		if (r.type === "message") return _typeFilters.has("messages");
		return true;
	});

	if (filtered.length === 0) {
		return html`
			<div class="flex flex-col items-center justify-center py-12 text-muted-foreground text-sm gap-1">
				<span>No matches for the selected filters</span>
			</div>
		`;
	}

	const groups = buildGroups(filtered);

	return html`
		<div class="flex flex-col gap-2">
			${_loading ? html`
				<div class="flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground">
					<span class="inline-block animate-spin">${icon(Loader2, "sm")}</span>
					Updating…
				</div>
			` : ""}
			${groups.map(g => _renderGroupCard(g))}
		</div>
	`;
}

export function renderSearchPage(): TemplateResult {
	_ensureStaleListener();
	const filterTypes = ["goals", "sessions", "staff", "messages"] as const;

	return html`
		<div class="flex-1 flex flex-col h-full overflow-hidden" style="background: var(--sidebar);">
			<div class="max-w-3xl w-full mx-auto px-4 py-6 flex flex-col gap-4 h-full overflow-y-auto">
				<!-- Search input -->
				<div class="flex items-center gap-2">
					<button
						class="shrink-0 p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
						@click=${() => { _initialized = false; history.back(); }}
						title="Back"
					>${icon(ArrowLeft, "sm")}</button>
					<div class="relative flex-1">
						<span class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
							${_loading
								? html`<span class="inline-block animate-spin">${icon(Loader2, "sm")}</span>`
								: icon(Search, "sm")}
						</span>
						<input
							type="text"
							.value=${_query}
							placeholder="Search everything..."
							class="w-full h-11 pl-10 pr-4 rounded-lg border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
							@input=${_handleInput}
							@keydown=${_handleKeydown}
							autofocus
						/>
					</div>
					<search-status-dot></search-status-dot>
				</div>

				<!-- Type filter toggles -->
				<div class="flex gap-2 flex-wrap">
					${filterTypes.map(type => html`
						<button
							class="px-3 py-1 rounded-full text-xs font-medium transition-colors inline-flex items-center gap-1.5
								${_typeFilters.has(type)
									? "bg-primary text-primary-foreground"
									: "bg-muted text-muted-foreground hover:bg-muted/80"}"
							@click=${() => _toggleFilter(type)}
						>
							${icon(_iconForType(type) as Parameters<typeof icon>[0], "xs")}
							${_capitalize(type)}
						</button>
					`)}
				</div>

				<!-- Stale-result toast -->
				${_staleToast ? html`
					<div
						data-role="stale-toast"
						class="px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs flex items-center justify-between gap-2"
						role="status"
					>
						<span>This result is no longer available — it may have been deleted.</span>
						<button
							class="shrink-0 px-2 py-0.5 rounded hover:bg-destructive/20 transition-colors"
							@click=${_dismissToast}
						>Dismiss</button>
					</div>
				` : ""}

				<!-- Results -->
				${_renderResults()}

				<!-- Load More -->
				${_results.length > 0 && _results.length < _total ? html`
					<div class="flex justify-center py-2">
						<button
							class="px-4 py-2 rounded-md text-sm text-primary hover:bg-primary/10 transition-colors"
							@click=${_loadMore}
							?disabled=${_loading}
						>
							${_loading ? "Loading…" : `Load More (${_total - _results.length} remaining)`}
						</button>
					</div>
				` : ""}
			</div>
		</div>
	`;
}
