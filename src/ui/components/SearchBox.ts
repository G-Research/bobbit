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

	protected override render() {
		if (this.collapsed) return html``;

		return html`
			<div class="relative px-2 pb-2">
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
						class="w-full h-8 pl-8 pr-8 rounded-md border border-input bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none transition-[color,box-shadow]"
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
		`;
	}
}
