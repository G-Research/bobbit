// ============================================================================
// FULL SEARCH PAGE — #/search route
// ============================================================================

import { html, nothing, type TemplateResult } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { ArrowLeft, Search, Loader2, Archive, Goal as GoalIcon, MessagesSquare, MessageSquare, Bot } from "lucide";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { searchApi } from "./api.js";
import { renderApp } from "./state.js";
import { setHashRoute, getRouteFromHash } from "./routing.js";
import { connectToSession } from "./session-manager.js";
import "./components/search-status-dot.js";

// ============================================================================
// MODULE-LEVEL STATE
// ============================================================================

let _query = "";
let _results: Array<{
	type: string;
	id: string;
	title: string;
	snippet: string;
	timestamp: number;
	archived: boolean;
	goalId?: string;
	sessionId?: string;
	sessionTitle?: string;
}> = [];
let _loading = false;
let _typeFilters = new Set(["goals", "sessions", "staff", "messages"]);
let _offset = 0;
let _total = 0;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _initialized = false;

// ============================================================================
// SEARCH LOGIC
// ============================================================================

async function _doSearch(append = false): Promise<void> {
	if (!_query.trim()) {
		_results = [];
		_total = 0;
		_loading = false;
		renderApp();
		return;
	}
	_loading = true;
	renderApp();
	const querySnapshot = _query;
	try {
		const data = await searchApi(_query, "all", 50, append ? _offset : 0);
		if (_query !== querySnapshot) return; // discard stale response
		if (!append) {
			_results = data.results;
			_offset = data.results.length;
		} else {
			_results = [..._results, ...data.results];
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
// RESULT CLICK HANDLERS
// ============================================================================

function _handleResultClick(result: typeof _results[0]): void {
	if (result.type === "goal") {
		setHashRoute("goal-dashboard", result.id);
	} else if (result.type === "session") {
		connectToSession(result.id, true);
	} else if (result.type === "staff") {
		setHashRoute("staff-edit", result.id);
	} else if (result.type === "message" && result.sessionId) {
		connectToSession(result.sessionId, true);
	}
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
		case "goals": return GoalIcon;
		case "sessions": return MessagesSquare;
		case "staff": return Bot;
		case "messages": return MessageSquare;
		default: return Search;
	}
}

// ============================================================================
// INIT
// ============================================================================

export function initSearchPage(): void {
	if (_initialized) return;
	const route = getRouteFromHash();
	_query = route.searchQuery || "";
	_offset = 0;
	_initialized = true;
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
// RENDER
// ============================================================================

function _renderResultRow(result: typeof _results[0]) {
	const title = result.type === "message"
		? (result.sessionTitle || result.title)
		: result.title;

	return html`
		<button
			class="w-full text-left px-3 py-2.5 rounded-lg hover:bg-accent/50 transition-colors cursor-pointer flex flex-col gap-1 group"
			@click=${() => _handleResultClick(result)}
		>
			<div class="flex items-center gap-2 min-w-0">
				<span class="truncate font-medium text-foreground text-sm">${title || "Untitled"}</span>
				${result.archived ? html`
					<span class="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[10px] bg-muted text-muted-foreground">
						${icon(Archive, "xs")} archived
					</span>
				` : ""}
				<span class="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
					${_relativeTime(result.timestamp)}
				</span>
			</div>
			${result.snippet ? html`
				<div class="text-xs text-muted-foreground line-clamp-2 leading-relaxed search-snippet">
					${unsafeHTML(_sanitizeSnippet(result.snippet))}
				</div>
			` : ""}
			${result.type === "message" && result.sessionTitle ? html`
				<div class="text-[10px] text-muted-foreground/60 flex items-center gap-1">
					${icon(MessagesSquare, "xs")} ${result.sessionTitle}
				</div>
			` : ""}
		</button>
	`;
}

function _renderGroup(type: string, items: typeof _results) {
	if (items.length === 0) return nothing;
	const lucideIcon = _iconForType(type);
	return html`
		<div class="mb-3">
			<div class="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
				${icon(lucideIcon as Parameters<typeof icon>[0], "sm")}
				${_capitalize(type)}
				<span class="ml-auto text-[10px] tabular-nums">${items.length}</span>
			</div>
			<div class="flex flex-col">${items.map(r => _renderResultRow(r))}</div>
		</div>
	`;
}

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

	// Filter results by active type filters
	const filtered = _results.filter(r => {
		if (r.type === "goal") return _typeFilters.has("goals");
		if (r.type === "session") return _typeFilters.has("sessions");
		if (r.type === "staff") return _typeFilters.has("staff");
		if (r.type === "message") return _typeFilters.has("messages");
		return true;
	});

	// Group by type
	const goals = filtered.filter(r => r.type === "goal");
	const sessions = filtered.filter(r => r.type === "session");
	const staff = filtered.filter(r => r.type === "staff");
	const messages = filtered.filter(r => r.type === "message");

	if (filtered.length === 0) {
		return html`
			<div class="flex flex-col items-center justify-center py-12 text-muted-foreground text-sm gap-1">
				<span>No matches for the selected filters</span>
			</div>
		`;
	}

	return html`
		<div class="flex flex-col gap-1">
			${_loading ? html`
				<div class="flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground">
					<span class="inline-block animate-spin">${icon(Loader2, "sm")}</span>
					Updating…
				</div>
			` : ""}
			${_renderGroup("goals", goals)}
			${_renderGroup("sessions", sessions)}
			${_renderGroup("staff", staff)}
			${_renderGroup("messages", messages)}
		</div>
	`;
}

export function renderSearchPage(): TemplateResult {
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
