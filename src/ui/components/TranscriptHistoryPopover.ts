import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Bot, CircleHelp, MessageSquare, Settings2 } from "lucide";
import type { PromptAuthorAppearance } from "../../app/message-author-appearance.js";
import { isMessageAuthor } from "../../shared/message-author.js";
import { getAccessoryDef, renderStaticSidebarBobbitCanvas } from "../bobbit-render.js";
import {
	filterTranscriptEntries,
	type TranscriptHistoryEntry,
	type TranscriptHistoryFilter,
} from "../transcript-history.js";

const FILTERS: ReadonlyArray<{ value: TranscriptHistoryFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "user", label: "User" },
	{ value: "system", label: "System" },
	{ value: "agent", label: "Agents" },
	{ value: "question", label: "Questions" },
];

export interface TranscriptHistorySelectDetail {
	entry: TranscriptHistoryEntry;
	targetId: string;
}

/**
 * Search and filter UI for the active transcript's derived history projection.
 * The parent owns transcript data, open state, and scrolling; this component
 * owns only ephemeral query/filter state and dialog lifecycle behavior.
 */
@customElement("transcript-history-popover")
export class TranscriptHistoryPopover extends LitElement {
	@property({ attribute: false }) entries: TranscriptHistoryEntry[] = [];
	@property({ type: Boolean, reflect: true }) open = false;
	@property({ attribute: false }) anchorEl: HTMLElement | null = null;
	@property({ type: Number, attribute: false }) availableHeight = 535;
	@property({ attribute: false }) resolvePromptAuthorAppearance?: (author: unknown) => PromptAuthorAppearance;

	@state() private _query = "";
	@state() private _filter: TranscriptHistoryFilter = "all";

	private _listenersBound = false;
	private _previousFocus: HTMLElement | null = null;
	private _wasAtTail = true;
	private _scrollNewestAfterUpdate = false;
	private readonly _onDocumentPointerDown = (event: PointerEvent) => {
		if (!this.open) return;
		const target = event.target as Node | null;
		if (!target || this.contains(target) || this.anchorEl?.contains(target)) return;
		this._requestClose();
	};
	private readonly _onDocumentKeyDown = (event: KeyboardEvent) => {
		if (!this.open || event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		this._requestClose();
	};

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "contents";
	}

	override disconnectedCallback(): void {
		this._unbindListeners();
		super.disconnectedCallback();
	}

	protected override willUpdate(changed: PropertyValues<this>): void {
		if (this.open && changed.has("entries") && !changed.has("open")) {
			this._wasAtTail = this._isListAtTail();
		}
	}

	protected override updated(changed: PropertyValues<this>): void {
		if (changed.has("open")) {
			if (this.open) this._handleOpen();
			else this._handleClosed();
		}

		if (!this.open) return;
		if (this._scrollNewestAfterUpdate || (changed.has("entries") && this._wasAtTail)) {
			this._scrollNewestAfterUpdate = false;
			this._scrollListToNewest();
		}
	}

	private _handleOpen(): void {
		this._previousFocus = document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
		this._query = "";
		this._filter = "all";
		this._scrollNewestAfterUpdate = true;
		this._bindListeners();
		queueMicrotask(() => {
			this.querySelector<HTMLInputElement>(".transcript-history-search")?.focus();
			this._scrollListToNewest();
		});
	}

	private _handleClosed(): void {
		this._unbindListeners();
		const focusTarget = this.anchorEl ?? this._previousFocus;
		this._previousFocus = null;
		try {
			focusTarget?.focus();
		} catch {
			// The trigger may have been removed with its parent during navigation.
		}
	}

	private _bindListeners(): void {
		if (this._listenersBound) return;
		document.addEventListener("pointerdown", this._onDocumentPointerDown, true);
		document.addEventListener("keydown", this._onDocumentKeyDown, true);
		this._listenersBound = true;
	}

	private _unbindListeners(): void {
		if (!this._listenersBound) return;
		document.removeEventListener("pointerdown", this._onDocumentPointerDown, true);
		document.removeEventListener("keydown", this._onDocumentKeyDown, true);
		this._listenersBound = false;
	}

	private _list(): HTMLElement | null {
		return this.querySelector<HTMLElement>(".transcript-history-list");
	}

	private _isListAtTail(): boolean {
		const list = this._list();
		if (!list) return true;
		return list.scrollHeight - list.clientHeight - list.scrollTop <= 4;
	}

	private _scrollListToNewest(): void {
		const list = this._list();
		if (list) list.scrollTop = list.scrollHeight;
	}

	private _requestClose(): void {
		if (!this.open) return;
		this.open = false;
		this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
	}

	private _select(entry: TranscriptHistoryEntry): void {
		this.open = false;
		this.dispatchEvent(new CustomEvent<TranscriptHistorySelectDetail>("transcript-entry-select", {
			detail: { entry, targetId: entry.targetId },
			bubbles: true,
			composed: true,
		}));
		this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
	}

	private _setFilter(filter: TranscriptHistoryFilter): void {
		if (filter === this._filter) return;
		this._filter = filter;
		this._scrollNewestAfterUpdate = true;
	}

	private _setQuery(event: Event): void {
		this._query = (event.currentTarget as HTMLInputElement).value;
		this._scrollNewestAfterUpdate = true;
	}

	private _questionStatus(entry: TranscriptHistoryEntry): "unanswered" | "answered" | "dismissed" | "failed" | null {
		if (entry.kind !== "question") return null;
		return entry.questionStatus ?? (entry.unresolved ? "unanswered" : "answered");
	}

	private _questionStatusLabel(entry: TranscriptHistoryEntry): string {
		const status = this._questionStatus(entry);
		return status ? `${status[0].toUpperCase()}${status.slice(1)}` : "";
	}

	private _rowLabel(entry: TranscriptHistoryEntry): string {
		const status = this._questionStatus(entry);
		const state = status ? `, ${status}` : "";
		return `${entry.authorLabel}, ${entry.typeLabel}${state}: ${entry.excerpt}`;
	}

	private _rowIcon(entry: TranscriptHistoryEntry) {
		const author = isMessageAuthor(entry.author) ? entry.author : undefined;
		if (author?.kind === "agent") {
			const appearance = this.resolvePromptAuthorAppearance?.(author);
			return html`
				<span class="prompt-author-avatar">
					${renderStaticSidebarBobbitCanvas({
						hueRotate: appearance?.hueRotate ?? 0,
						accessory: getAccessoryDef(appearance?.accessoryId),
					})}
				</span>
			`;
		}
		if (author?.kind === "user") {
			return html`<span class="prompt-author-initial" data-initial="U"></span>`;
		}
		if (author?.kind === "system") {
			return html`<span class="prompt-author-system-icon">${icon(Settings2, "xs")}</span>`;
		}
		switch (entry.kind) {
			case "user": return icon(MessageSquare, "sm");
			case "system": return icon(Settings2, "sm");
			case "question": return icon(CircleHelp, "sm");
			default: return icon(Bot, "sm");
		}
	}

	override render() {
		if (!this.open) return nothing;

		const filtered = filterTranscriptEntries(this.entries, this._filter, this._query);
		return html`
			<style>
				transcript-history-popover .transcript-history-dialog {
					position: absolute;
					box-sizing: border-box;
					top: calc(100% + 6px);
					left: 50%;
					transform: translateX(-50%);
					z-index: 50;
					display: flex;
					width: min(420px, calc(100vw - 24px));
					max-height: min(535px, var(--transcript-history-available-height, 535px));
					flex-direction: column;
					overflow: hidden;
					padding: 12px;
					border: 1px solid var(--border);
					border-radius: 8px;
					background: var(--card);
					color: var(--foreground);
					box-shadow:
						0 10px 15px -3px color-mix(in oklch, var(--foreground) 12%, transparent),
						0 4px 6px -4px color-mix(in oklch, var(--foreground) 12%, transparent);
					font-size: 13px;
				}
				transcript-history-popover .transcript-history-visually-hidden {
					position: absolute;
					width: 1px;
					height: 1px;
					padding: 0;
					margin: -1px;
					overflow: hidden;
					clip: rect(0, 0, 0, 0);
					white-space: nowrap;
					border: 0;
				}
				transcript-history-popover .transcript-history-search-wrap {
					padding: 0 0 8px;
				}
				transcript-history-popover .transcript-history-search {
					box-sizing: border-box;
					width: 100%;
					border: 1px solid var(--border);
					border-radius: 4px;
					background: var(--card);
					color: var(--foreground);
					padding: 6px 8px;
					font: inherit;
					outline: none;
				}
				transcript-history-popover .transcript-history-search:focus-visible,
				transcript-history-popover .transcript-history-filter:focus-visible,
				transcript-history-popover .transcript-history-row:focus-visible {
					outline: 2px solid var(--ring);
					outline-offset: 2px;
				}
				transcript-history-popover .transcript-history-filters {
					display: flex;
					flex-wrap: wrap;
					align-items: center;
					gap: 4px;
					padding: 0 0 10px;
					border-bottom: 1px solid var(--border);
				}
				transcript-history-popover .transcript-history-filter {
					flex: 0 0 auto;
					min-height: 26px;
					border: 1px solid transparent;
					border-radius: 999px;
					background: transparent;
					color: var(--muted-foreground);
					padding: 3px 8px;
					font: inherit;
					font-size: 12px;
					font-weight: 500;
					line-height: 1.2;
					white-space: nowrap;
					cursor: pointer;
					transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
				}
				transcript-history-popover .transcript-history-filter:hover {
					background: color-mix(in oklch, var(--muted) 50%, transparent);
					color: var(--foreground);
				}
				transcript-history-popover .transcript-history-filter[aria-pressed="true"] {
					border-color: var(--border);
					background: color-mix(in oklch, var(--muted) 70%, transparent);
					color: var(--foreground);
					font-weight: 600;
				}
				transcript-history-popover .transcript-history-list {
					min-height: 0;
					flex: 1 1 auto;
					overflow-y: auto;
					padding: 6px 0 0;
				}
				transcript-history-popover .transcript-history-row {
					display: grid;
					grid-template-columns: 24px minmax(0, 1fr);
					align-items: start;
					column-gap: 8px;
					box-sizing: border-box;
					width: 100%;
					border: 0;
					border-radius: 4px;
					background: transparent;
					color: inherit;
					padding: 7px 8px;
					text-align: left;
					font: inherit;
					cursor: pointer;
				}
				transcript-history-popover .transcript-history-row:hover {
					background: color-mix(in oklch, var(--muted) 50%, transparent);
				}
				transcript-history-popover .transcript-history-row-icon {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					width: 24px;
					height: 24px;
					border-radius: 4px;
					background: color-mix(in oklch, var(--muted) 45%, transparent);
					color: var(--muted-foreground);
				}
				transcript-history-popover .transcript-history-row-icon[data-author-kind] {
					background: transparent;
				}
				transcript-history-popover .transcript-history-row-icon > svg {
					width: 14px;
					height: 14px;
				}
				transcript-history-popover .transcript-history-row-content {
					min-width: 0;
				}
				transcript-history-popover .transcript-history-row-meta {
					display: flex;
					align-items: center;
					gap: 6px;
					margin-bottom: 3px;
					color: var(--muted-foreground);
					font-size: 11px;
				}
				transcript-history-popover .transcript-history-row-author {
					color: var(--foreground);
					font-weight: 600;
				}
				transcript-history-popover .transcript-history-question-status {
					font-weight: 600;
					text-transform: capitalize;
				}
				transcript-history-popover .transcript-history-question-status[data-status="unanswered"] {
					color: var(--warning);
				}
				transcript-history-popover .transcript-history-question-status[data-status="answered"] {
					color: var(--positive);
				}
				transcript-history-popover .transcript-history-question-status[data-status="dismissed"] {
					color: var(--muted-foreground);
				}
				transcript-history-popover .transcript-history-question-status[data-status="failed"] {
					color: var(--negative);
				}
				transcript-history-popover .transcript-history-excerpt {
					display: -webkit-box;
					overflow: hidden;
					-webkit-box-orient: vertical;
					-webkit-line-clamp: 2;
					line-height: 1.35;
				}
				transcript-history-popover .transcript-history-empty {
					padding: 30px 16px;
					color: var(--muted-foreground);
					text-align: center;
				}
				@media (max-width: 639px) {
					transcript-history-popover .transcript-history-dialog {
						width: calc(100vw - 24px);
					}
				}
			</style>
			<section
				id="transcript-history-popover"
				class="transcript-history-dialog"
				style="--transcript-history-available-height: ${Math.max(0, Math.floor(this.availableHeight))}px"
				role="dialog"
				aria-modal="false"
				aria-labelledby="transcript-history-title"
			>
				<h2 id="transcript-history-title" class="transcript-history-visually-hidden">Transcript history</h2>
				<div class="transcript-history-search-wrap">
					<label class="transcript-history-visually-hidden" for="transcript-history-search">Search transcript</label>
					<input
						id="transcript-history-search"
						class="transcript-history-search"
						type="search"
						placeholder="Search transcript…"
						autocomplete="off"
						.value=${this._query}
						@input=${this._setQuery}
					/>
				</div>
				<div class="transcript-history-filters" role="group" aria-label="Filter transcript history">
					${FILTERS.map(({ value, label }) => html`
						<button
							type="button"
							class="transcript-history-filter"
							aria-pressed=${this._filter === value ? "true" : "false"}
							@click=${() => this._setFilter(value)}
						>${label}</button>
					`)}
				</div>
				<div class="transcript-history-list">
					${filtered.length === 0
						? html`<div class="transcript-history-empty" role="status">No matching prompts</div>`
						: filtered.map((entry) => html`
							<button
								type="button"
								class="transcript-history-row"
								data-entry-id=${entry.id}
								data-target-id=${entry.targetId}
								aria-label=${this._rowLabel(entry)}
								@click=${() => this._select(entry)}
							>
								<span
									class="transcript-history-row-icon"
									data-kind=${entry.kind}
									data-author-kind=${isMessageAuthor(entry.author) ? entry.author.kind : nothing}
									aria-hidden="true"
								>${this._rowIcon(entry)}</span>
								<span class="transcript-history-row-content">
									<span class="transcript-history-row-meta">
										<span class="transcript-history-row-author">${entry.authorLabel}</span>
										<span aria-hidden="true">·</span>
										<span>${entry.typeLabel}</span>
										${this._questionStatus(entry) ? html`
											<span
												class="transcript-history-question-status"
												data-status=${this._questionStatus(entry)}
											>${this._questionStatusLabel(entry)}</span>
										` : nothing}
									</span>
									<span class="transcript-history-excerpt">${entry.excerpt}</span>
								</span>
							</button>
						`)}
				</div>
			</section>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"transcript-history-popover": TranscriptHistoryPopover;
	}
}
