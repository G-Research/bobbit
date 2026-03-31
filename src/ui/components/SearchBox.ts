import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icon } from "@mariozechner/mini-lit";
import { Search, X, Loader2 } from "lucide";

/**
 * Sidebar search input with debounced queries, keyboard shortcut (Ctrl+K / Cmd+K),
 * and clear/escape behavior.
 *
 * Events:
 *  - `search-input`: fired after 200ms debounce, detail: { query: string }
 *  - `search-clear`: fired when the user clears/escapes
 */
@customElement("search-box")
export class SearchBox extends LitElement {
	@property({ type: String }) query = "";
	@property({ type: Boolean }) collapsed = false;
	@property({ type: Boolean }) loading = false;
	@property({ type: Boolean }) contentMode = false;
	@property({ type: Boolean }) showControls = false;

	@state() private _focused = false;

	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _boundKeydown: ((e: KeyboardEvent) => void) | null = null;

	protected override createRenderRoot() {
		return this; // light DOM — Tailwind works
	}

	override connectedCallback() {
		super.connectedCallback();
		this._boundKeydown = this._handleGlobalKeydown.bind(this);
		document.addEventListener("keydown", this._boundKeydown);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		if (this._boundKeydown) {
			document.removeEventListener("keydown", this._boundKeydown);
			this._boundKeydown = null;
		}
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = null;
		}
	}

	/** Ctrl+K / Cmd+K focuses the input. */
	private _handleGlobalKeydown(e: KeyboardEvent) {
		if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			this._focusInput();
		}
	}

	private _focusInput() {
		const input = this.querySelector<HTMLInputElement>("input[data-search]");
		input?.focus();
	}

	private _handleInput(e: Event) {
		const value = (e.target as HTMLInputElement).value;
		this.query = value;

		if (this._debounceTimer) clearTimeout(this._debounceTimer);
		this._debounceTimer = setTimeout(() => {
			this._debounceTimer = null;
			this.dispatchEvent(new CustomEvent("search-input", {
				bubbles: true,
				composed: true,
				detail: { query: this.query },
			}));
		}, 200);
	}

	private _handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			this._clear();
			(e.target as HTMLInputElement).blur();
		}
	}

	private _clear() {
		this.query = "";
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = null;
		}
		this.dispatchEvent(new CustomEvent("search-clear", { bubbles: true, composed: true }));
	}

	private _toggleContentMode(e: Event) {
		const checked = (e.target as HTMLInputElement).checked;
		this.dispatchEvent(new CustomEvent("search-mode-change", {
			bubbles: true, composed: true,
			detail: { contentSearch: checked },
		}));
	}

	private _fullSearch() {
		this.dispatchEvent(new CustomEvent("full-search-click", {
			bubbles: true, composed: true,
			detail: { query: this.query },
		}));
	}

	protected override render() {
		if (this.collapsed) return html``;

		return html`
			<div>
				<div class="relative pb-1">
					<div class="relative flex items-center">
						<span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none ${this._focused ? "text-foreground" : ""}">
							${this.loading
								? html`<span class="inline-block animate-spin">${icon(Loader2, "sm")}</span>`
								: icon(Search, "sm")}
						</span>
						<input
							data-search
							type="text"
							.value=${this.query}
							placeholder="Search… (${navigator.platform?.includes("Mac") ? "⌘" : "Ctrl+"}K)"
							class="w-full h-7 pl-8 pr-8 border border-input bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none transition-[color,box-shadow]"
							@input=${this._handleInput}
							@keydown=${this._handleKeydown}
							@focus=${() => { this._focused = true; }}
							@blur=${() => { this._focused = false; }}
						/>
						${this.query
							? html`
								<button
									class="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
									@click=${this._clear}
									aria-label="Clear search"
								>
									${icon(X, "sm")}
								</button>`
							: ""}
					</div>
				</div>
				<div class="overflow-hidden transition-all duration-200 ease-in-out" style="max-height: ${this.showControls ? "28px" : "0"}; opacity: ${this.showControls ? "1" : "0"}">
					<div class="flex items-center justify-between px-2 py-0.5 text-[11px]">
						<label class="flex items-center gap-1 text-muted-foreground hover:text-foreground cursor-pointer select-none transition-colors">
							<input type="checkbox" .checked=${this.contentMode} @change=${this._toggleContentMode} class="w-3 h-3 accent-primary" />
							Search Content
						</label>
						<button class="text-primary hover:text-primary/80 hover:underline transition-colors" @click=${this._fullSearch}>
							Full Search
						</button>
					</div>
				</div>
			</div>
		`;
	}
}
