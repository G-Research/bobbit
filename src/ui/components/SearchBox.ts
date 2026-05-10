import { html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icon } from "@mariozechner/mini-lit";
import { Search, X } from "lucide";
import { BobbitElement } from "./base/BobbitElement.js";
import { LifecycleTimers } from "./base/lifecycle-timers.js";

/**
 * Sidebar search input with debounced queries, keyboard shortcut (Ctrl+K / Cmd+K),
 * and clear/escape behavior.
 *
 * Events:
 *  - `search-input`: fired after 200ms debounce, detail: { query: string }
 *  - `search-clear`: fired when the user clears/escapes
 */
@customElement("search-box")
export class SearchBox extends BobbitElement {
	@property({ type: String }) query = "";
	@property({ type: Boolean }) collapsed = false;

	@property({ type: Boolean }) showControls = false;

	@state() private _focused = false;

	private _debounceTimer: number | null = null;
	private _timers = new LifecycleTimers(this.signal);

	protected override createRenderRoot() {
		return this; // light DOM — Tailwind works
	}

	override connectedCallback() {
		super.connectedCallback();
		// Re-attach: refresh the timers helper to bind to the new lifecycle signal.
		this._timers = new LifecycleTimers(this.signal);
		document.addEventListener("keydown", this._handleGlobalKeydown, { signal: this.signal });
	}

	/** Ctrl+K / Cmd+K focuses the input. */
	private _handleGlobalKeydown = (e: KeyboardEvent) => {
		if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			this._focusInput();
		}
	};

	private _focusInput() {
		const input = this.querySelector<HTMLInputElement>("input[data-search]");
		input?.focus();
	}

	private _handleInput(e: Event) {
		const value = (e.target as HTMLInputElement).value;
		this.query = value;

		if (this._debounceTimer !== null) clearTimeout(this._debounceTimer);
		this._debounceTimer = this._timers.setTimeout(() => {
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
		if (this._debounceTimer !== null) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = null;
		}
		this.dispatchEvent(new CustomEvent("search-clear", { bubbles: true, composed: true }));
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
							${icon(Search, "sm")}
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
					<div class="flex items-center justify-end px-2 py-0.5 text-[11px]">
						<button class="text-primary hover:text-primary/80 hover:underline transition-colors" @click=${this._fullSearch}>
							Full Search
						</button>
					</div>
				</div>
			</div>
		`;
	}
}
