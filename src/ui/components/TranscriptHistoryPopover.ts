import { html, LitElement, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
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

	private _rowLabel(entry: TranscriptHistoryEntry): string {
		const state = entry.kind === "question" && entry.unresolved ? ", unanswered" : "";
		return `${entry.authorLabel}, ${entry.typeLabel}${state}: ${entry.excerpt}`;
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
					width: min(475px, calc(100vw - 24px));
					max-height: min(535px, var(--transcript-history-available-height, 535px));
					flex-direction: column;
					overflow: hidden;
					border: 1px solid var(--border);
					border-radius: 10px;
					background: var(--popover);
					color: var(--popover-foreground);
					box-shadow: 0 14px 36px color-mix(in oklch, var(--foreground) 16%, transparent);
					font-size: 12px;
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
					padding: 12px 12px 9px;
				}
				transcript-history-popover .transcript-history-search {
					box-sizing: border-box;
					width: 100%;
					border: 1px solid var(--input);
					border-radius: 7px;
					background: var(--background);
					color: var(--foreground);
					padding: 7px 9px;
					font: inherit;
					font-size: 13px;
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
					gap: 4px;
					overflow-x: auto;
					padding: 0 12px 9px;
					border-bottom: 1px solid var(--border);
				}
				transcript-history-popover .transcript-history-filter {
					flex: 0 0 auto;
					border: 1px solid transparent;
					border-radius: 999px;
					background: transparent;
					color: var(--muted-foreground);
					padding: 4px 9px;
					font: inherit;
					font-weight: 500;
					cursor: pointer;
				}
				transcript-history-popover .transcript-history-filter:hover {
					background: var(--muted);
					color: var(--foreground);
				}
				transcript-history-popover .transcript-history-filter[aria-pressed="true"] {
					border-color: var(--border);
					background: var(--accent);
					color: var(--accent-foreground);
				}
				transcript-history-popover .transcript-history-list {
					min-height: 0;
					flex: 1 1 auto;
					overflow-y: auto;
					padding: 5px;
				}
				transcript-history-popover .transcript-history-row {
					display: block;
					box-sizing: border-box;
					width: 100%;
					border: 0;
					border-radius: 6px;
					background: transparent;
					color: inherit;
					padding: 8px 9px;
					text-align: left;
					font: inherit;
					cursor: pointer;
				}
				transcript-history-popover .transcript-history-row:hover {
					background: var(--muted);
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
				transcript-history-popover .transcript-history-unanswered {
					color: var(--warning);
					font-weight: 600;
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
				transcript-history-popover .transcript-history-footer {
					border-top: 1px solid var(--border);
					padding: 7px 12px;
					color: var(--muted-foreground);
					font-size: 11px;
					text-align: right;
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
								<span class="transcript-history-row-meta">
									<span class="transcript-history-row-author">${entry.authorLabel}</span>
									<span aria-hidden="true">·</span>
									<span>${entry.typeLabel}</span>
									${entry.kind === "question" && entry.unresolved
										? html`<span class="transcript-history-unanswered">Unanswered</span>`
										: nothing}
								</span>
								<span class="transcript-history-excerpt">${entry.excerpt}</span>
							</button>
						`)}
				</div>
				<div class="transcript-history-footer">Oldest → newest</div>
			</section>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"transcript-history-popover": TranscriptHistoryPopover;
	}
}
