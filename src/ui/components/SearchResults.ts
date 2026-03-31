import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { icon } from "@mariozechner/mini-lit";
import { Archive, Goal as GoalIcon, Loader2, MessageSquare, MessagesSquare } from "lucide";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

/** A single search result from the API. */
export interface SearchResult {
	type: "goal" | "session" | "message";
	id: string;
	title: string;
	snippet: string;
	timestamp: number;
	archived: boolean;
	goalId?: string;
	sessionId?: string;
	sessionTitle?: string;
}

/**
 * Displays grouped search results (Goals, Sessions, Messages) with clickable
 * rows, snippet highlights, relative timestamps, and archived badges.
 *
 * Events:
 *  - `result-click`: detail: { type, id, sessionId?, goalId? }
 */
@customElement("search-results")
export class SearchResults extends LitElement {
	@property({ attribute: false }) results: SearchResult[] = [];
	@property({ type: Boolean }) loading = false;
	@property({ type: String }) query = "";

	protected override createRenderRoot() {
		return this; // light DOM
	}

	private _handleClick(result: SearchResult) {
		this.dispatchEvent(new CustomEvent("result-click", {
			bubbles: true,
			composed: true,
			detail: {
				type: result.type,
				id: result.id,
				sessionId: result.sessionId,
				goalId: result.goalId,
			},
		}));
	}

	protected override render() {
		// Loading state
		if (this.loading && this.results.length === 0) {
			return html`
				<div class="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
					<span class="inline-block animate-spin">${icon(Loader2, "sm")}</span>
					Searching…
				</div>
			`;
		}

		// Empty state
		if (!this.loading && this.query && this.results.length === 0) {
			return html`
				<div class="flex flex-col items-center justify-center py-8 text-muted-foreground text-sm gap-1">
					<span>No matches for "${this.query}"</span>
				</div>
			`;
		}

		// No query yet
		if (!this.query) return nothing;

		// Group results by type
		const goals = this.results.filter(r => r.type === "goal");
		const sessions = this.results.filter(r => r.type === "session");
		const messages = this.results.filter(r => r.type === "message");

		return html`
			<div class="flex flex-col gap-1 px-2 pb-2 overflow-y-auto text-sm">
				${this.loading ? html`
					<div class="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
						<span class="inline-block animate-spin">${icon(Loader2, "sm")}</span>
						Updating…
					</div>
				` : ""}
				${goals.length ? this._renderGroup("Goals", GoalIcon, goals) : ""}
				${sessions.length ? this._renderGroup("Sessions", MessagesSquare, sessions) : ""}
				${messages.length ? this._renderGroup("Messages", MessageSquare, messages) : ""}
			</div>
		`;
	}

	private _renderGroup(label: string, lucideIcon: object, items: SearchResult[]) {
		return html`
			<div class="mb-1">
				<div class="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
					${icon(lucideIcon as Parameters<typeof icon>[0], "sm")}
					${label}
					<span class="ml-auto text-[10px] tabular-nums">${items.length}</span>
				</div>
				${items.map(r => this._renderResult(r))}
			</div>
		`;
	}

	private _renderResult(result: SearchResult) {
		const title = result.type === "message"
			? (result.sessionTitle || result.title)
			: result.title;

		return html`
			<button
				class="w-full text-left px-2 py-1.5 rounded-md hover:bg-accent/50 transition-colors cursor-pointer flex flex-col gap-0.5 group"
				@click=${() => this._handleClick(result)}
			>
				<div class="flex items-center gap-1.5 min-w-0">
					<span class="truncate font-medium text-foreground text-xs">${title || "Untitled"}</span>
					${result.archived ? html`
						<span class="shrink-0 inline-flex items-center gap-0.5 px-1 py-0 rounded text-[10px] bg-muted text-muted-foreground">
							${icon(Archive, "xs")}
						</span>
					` : ""}
					<span class="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
						${_relativeTime(result.timestamp)}
					</span>
				</div>
				${result.snippet ? html`
					<div class="text-xs text-muted-foreground line-clamp-2 leading-relaxed search-snippet">
						${unsafeHTML(_sanitizeSnippet(result.snippet))}
					</div>
				` : ""}
			</button>
		`;
	}
}

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
 * Strips anything that isn't <b> or </b>.
 */
function _sanitizeSnippet(raw: string): string {
	// FTS5 snippet() wraps matches in <b>...</b> by default (configurable).
	// Allow only <b> and </b>, escape everything else.
	return raw
		.replace(/<b>/gi, "\x00B")
		.replace(/<\/b>/gi, "\x00E")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\x00B/g, "<b>")
		.replace(/\x00E/g, "</b>");
}
