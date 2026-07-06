/**
 * DirectoryPicker — reusable light-DOM Lit component for typing or picking
 * an absolute directory path.
 *
 * Data-driven and event-based:
 *   - The component owns the input value, the suggestion list, keyboard
 *     navigation, and a debounced typeahead.
 *   - It does NOT call `gatewayFetch`. The caller injects a `browseDirectory`
 *     function so the picker can be unit-tested or reused for non-server
 *     surfaces (e.g. story fixtures).
 *   - It does NOT open a browse modal — it fires `directory-browse-request`
 *     and lets the parent dialog decide how to surface a browse UI.
 *
 * Usage:
 * ```ts
 * import "../ui/components/DirectoryPicker.js";
 * import { browseDirectory } from "../app/api.js";
 *
 * html`
 *   <directory-picker
 *     .value=${pathValue}
 *     .browseDirectory=${browseDirectory}
 *     .recentPaths=${recent}
 *     placeholder="/path/to/project"
 *     @directory-input=${(e) => onTyped(e.detail.path)}
 *     @directory-select=${(e) => onPicked(e.detail.path)}
 *     @directory-commit=${(e) => onContinue(e.detail.path)}
 *     @directory-browse-request=${() => openBrowseModal()}
 *     @directory-cancel=${() => closeDialog()}
 *   ></directory-picker>
 * `;
 * ```
 *
 * Layout invariant: the suggestion popover is `position: absolute` so it
 * overlays the surrounding layout rather than pushing it. The picker root
 * itself reserves a fixed height (input + browse button row) and does not
 * change size when suggestions open/close.
 */

import { html, LitElement, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DirectoryEntry {
	name: string;
	path: string;
}

export interface DirectoryBrowseResult {
	current: string;
	parent: string | null;
	entries: DirectoryEntry[];
	truncated?: boolean;
}

export interface DirectorySuggestion extends DirectoryEntry {
	source: "browse" | "recent";
	/** Optional muted label shown after the basename (e.g. "Recent"). */
	hint?: string;
}

export type DirectoryPickerChangeSource = "typed" | "suggestion" | "browse";

export interface DirectoryPickerPathDetail {
	path: string;
	source: DirectoryPickerChangeSource;
}

export interface DirectoryBrowseRequestDetail {
	path: string;
}

export interface BrowseDirectoryOptions {
	prefix?: string;
	limit?: number;
}

export type BrowseDirectoryFn = (path?: string, options?: BrowseDirectoryOptions) => Promise<DirectoryBrowseResult>;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SEPARATOR_REGEX = /[\\/]/;
const TRAILING_SEPARATOR_REGEX = /[\\/]$/;

/**
 * Split a typed path into `{ parent, basename }` for suggestion lookup.
 *
 *   "/foo/bar/ba"   → { parent: "/foo/bar", basename: "ba" }
 *   "/foo/bar/"     → { parent: "/foo/bar", basename: "" }
 *   "/foo/bar"      → { parent: "/foo",     basename: "bar" }
 *   "C:\\Users\\j"  → { parent: "C:\\Users", basename: "j" }
 *   "C:\\Us"       → { parent: "C:\\",      basename: "Us" }
 *   "/"             → { parent: "/",         basename: "" }
 *   ""              → { parent: null,        basename: "" }
 */
function directoryFromTrailingPath(raw: string): string | null {
	const value = raw ?? "";
	if (!value) return null;
	const trimmed = value.replace(/[\\/]+$/, "");
	if (trimmed === "") return "/";
	// Preserve Windows drive roots. `C:\\` should browse `C:\\`, not `C:`.
	if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}\\`;
	return trimmed;
}

function splitPath(raw: string): { parent: string | null; basename: string } {
	const value = raw ?? "";
	if (!value) return { parent: null, basename: "" };

	// Trailing separator → user is inside the directory, no basename filter.
	if (TRAILING_SEPARATOR_REGEX.test(value)) {
		return { parent: directoryFromTrailingPath(value), basename: "" };
	}

	// Find last separator.
	let lastSep = -1;
	for (let i = value.length - 1; i >= 0; i--) {
		if (SEPARATOR_REGEX.test(value[i] ?? "")) {
			lastSep = i;
			break;
		}
	}
	if (lastSep < 0) {
		// No separator at all — typed bare word, no useful parent.
		return { parent: null, basename: value };
	}
	const parent = lastSep === 0
		? "/"
		: lastSep === 2 && /^[A-Za-z]:[\\/]$/.test(value.slice(0, 3))
			? value.slice(0, 3)
			: value.slice(0, lastSep);
	const basename = value.slice(lastSep + 1);
	return { parent, basename };
}

type LookupIntent =
	| { kind: "recent"; key: string }
	| { kind: "browse"; parent: string; basename: string; key: string }
	| { kind: "none"; key: string };

@customElement("directory-picker")
export class DirectoryPicker extends LitElement {
	// --- public API --------------------------------------------------------

	@property({ type: String }) value = "";
	@property({ type: String }) placeholder = "/path/to/project";
	@property({ attribute: false }) browseDirectory!: BrowseDirectoryFn;
	@property({ attribute: false }) recentPaths: Array<{ path: string; source: string }> = [];
	@property({ type: Number }) debounceMs = 200;
	@property({ type: Number }) maxSuggestions = 12;
	@property({ type: Boolean }) disabled = false;
	@property({ type: Boolean }) showBrowseButton = true;

	// --- internal state ---------------------------------------------------

	@state() private _suggestions: DirectorySuggestion[] = [];
	@state() private _open = false;
	@state() private _highlight = -1;
	@state() private _loading = false;
	@state() private _inputFocused = false;

	@query("input.directory-picker-input") private _inputEl?: HTMLInputElement;

	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
	/** Monotonic token to ignore stale browse responses. */
	private _browseToken = 0;
	/** Last `value` we ran a suggestion lookup against (avoid duplicate work). */
	private _lastQueried: string | null = null;
	/** Exact value last committed by a suggestion or parent-driven completed selection. */
	private _completedPath: string | null = null;
	/** Set while value changes originate from the user's keystrokes. */
	private _valueChangingFromInput = false;

	protected override createRenderRoot(): this {
		return this;
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._cancelPendingLookup(true);
	}

	protected override updated(changed: PropertyValues<this>): void {
		if (!changed.has("value")) return;
		if (this._valueChangingFromInput) {
			this._valueChangingFromInput = false;
			return;
		}
		// External value writes come from completed programmatic selections (for
		// example the Browse dialog). Treat them like a committed path so focus
		// restoration cannot immediately open the selected folder's children.
		this._markCompletedPath(this.value ?? "");
	}

	/** Public: focus the inner text input. */
	focusInput(): void {
		// Wait one microtask so the input exists if called immediately after render.
		Promise.resolve().then(() => {
			this._inputEl?.focus();
		});
	}

	/** Public: set a path that is already complete without opening suggestions. */
	setCompletedPath(path: string): void {
		this._markCompletedPath(path ?? "");
	}

	// --- event helpers ----------------------------------------------------

	private _fire<T>(name: string, detail: T): void {
		this.dispatchEvent(new CustomEvent<T>(name, {
			bubbles: true,
			composed: true,
			detail,
		}));
	}

	// --- suggestion lookup ------------------------------------------------

	private _cancelPendingLookup(invalidate = false): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = null;
		}
		if (invalidate) this._browseToken++;
		this._loading = false;
	}

	private _markCompletedPath(path: string): void {
		this.value = path;
		this._completedPath = path.trim() ? path : null;
		this._lastQueried = path;
		this._suggestions = [];
		this._open = false;
		this._highlight = -1;
		this._cancelPendingLookup(true);
	}

	private _hasActiveInput(): boolean {
		return this._inputFocused && this._inputEl != null && document.activeElement === this._inputEl;
	}

	private _lookupIntent(value: string): LookupIntent {
		if (!this._hasActiveInput()) return { kind: "none", key: "blurred" };
		if (value.trim() === "") return { kind: "recent", key: "recent" };
		if (this._completedPath != null && value === this._completedPath) {
			return { kind: "none", key: `completed:${value}` };
		}
		if (TRAILING_SEPARATOR_REGEX.test(value)) {
			const parent = directoryFromTrailingPath(value);
			return parent
				? { kind: "browse", parent, basename: "", key: `browse:${parent}:` }
				: { kind: "none", key: "invalid-trailing" };
		}
		const { parent, basename } = splitPath(value);
		return parent
			? { kind: "browse", parent, basename, key: `browse:${parent}:${basename}` }
			: { kind: "none", key: "no-parent" };
	}

	private _lookupStillValid(token: number, value: string, intent: LookupIntent): boolean {
		if (token !== this._browseToken) return false;
		if (!this._hasActiveInput()) return false;
		if ((this.value ?? "") !== value) return false;
		return this._lookupIntent(value).key === intent.key;
	}

	private _applySuggestions(suggestions: DirectorySuggestion[]): void {
		this._suggestions = suggestions;
		this._highlight = suggestions.length > 0 ? 0 : -1;
		this._open = this._hasActiveInput() && suggestions.length > 0;
		this._loading = false;
	}

	private _scheduleLookup(immediate = false): void {
		this._cancelPendingLookup(false);
		if (!this._hasActiveInput()) return;
		const run = () => {
			this._debounceTimer = null;
			void this._runLookup();
		};
		if (immediate || this.debounceMs <= 0) {
			run();
		} else {
			this._debounceTimer = setTimeout(run, this.debounceMs);
		}
	}

	private _recentAsSuggestions(): DirectorySuggestion[] {
		const seen = new Set<string>();
		const out: DirectorySuggestion[] = [];
		for (const r of this.recentPaths) {
			if (!r?.path || seen.has(r.path)) continue;
			seen.add(r.path);
			// Derive a basename for display.
			const parts = r.path.split(SEPARATOR_REGEX).filter(Boolean);
			const name = parts.length > 0 ? (parts[parts.length - 1] ?? r.path) : r.path;
			out.push({ name, path: r.path, source: "recent", hint: "Recent" });
			if (out.length >= this.maxSuggestions) break;
		}
		return out;
	}

	private async _runLookup(): Promise<void> {
		const value = this.value ?? "";
		const intent = this._lookupIntent(value);
		this._lastQueried = value;
		const token = ++this._browseToken;

		if (intent.kind === "none") {
			this._applySuggestions([]);
			return;
		}

		// Empty input → recent paths only.
		if (intent.kind === "recent") {
			const recents = this._recentAsSuggestions();
			if (!this._lookupStillValid(token, value, intent)) return;
			this._applySuggestions(recents);
			return;
		}

		// Intent-based lookup: browse only the parent for typed prefixes. Browse
		// the completed directory itself only when the user typed a trailing
		// separator, which creates an explicit child-list request.
		this._loading = true;
		let result: DirectoryBrowseResult | null = null;
		try {
			result = await this.browseDirectory(intent.parent, {
				prefix: intent.basename || undefined,
				limit: this.maxSuggestions,
			});
		} catch {
			result = null;
		}

		if (!this._lookupStillValid(token, value, intent)) return;

		const suggestions: DirectorySuggestion[] = [];
		if (result && Array.isArray(result.entries)) {
			const lowerFilter = intent.basename.toLowerCase();
			for (const entry of result.entries) {
				if (!entry?.path || !entry?.name) continue;
				if (lowerFilter && !entry.name.toLowerCase().startsWith(lowerFilter)) continue;
				suggestions.push({
					name: entry.name,
					path: entry.path,
					source: "browse",
				});
				if (suggestions.length >= this.maxSuggestions) break;
			}
		}

		if (suggestions.length === 0 && this.recentPaths.length > 0) {
			// Filter recents by typed substring (case-insensitive) so the user
			// still sees something familiar even when browse fails.
			const needle = value.toLowerCase();
			for (const r of this.recentPaths) {
				if (!r?.path) continue;
				if (!r.path.toLowerCase().includes(needle)) continue;
				const parts = r.path.split(SEPARATOR_REGEX).filter(Boolean);
				const name = parts.length > 0 ? (parts[parts.length - 1] ?? r.path) : r.path;
				suggestions.push({ name, path: r.path, source: "recent", hint: "Recent" });
				if (suggestions.length >= this.maxSuggestions) break;
			}
		}

		this._applySuggestions(suggestions);
	}

	// --- DOM event handlers ----------------------------------------------

	private _onInput = (e: Event): void => {
		const next = (e.target as HTMLInputElement).value;
		this._valueChangingFromInput = true;
		this.value = next;
		if (next !== this._completedPath) this._completedPath = null;
		this._suggestions = [];
		this._open = false;
		this._highlight = -1;
		this._loading = false;
		this._fire<DirectoryPickerPathDetail>("directory-input", {
			path: next,
			source: "typed",
		});
		this._scheduleLookup();
	};

	private _onFocus = (): void => {
		this._inputFocused = true;
		if (this.disabled) return;
		const value = this.value ?? "";
		if (this._completedPath != null && value === this._completedPath) {
			this._open = false;
			return;
		}
		// Re-run lookup if the value changed since last query, otherwise just open.
		if (this._lastQueried !== value) {
			this._scheduleLookup(true);
		} else if (this._suggestions.length > 0) {
			this._open = true;
		} else if (value.trim() === "" && this.recentPaths.length > 0) {
			this._scheduleLookup(true);
		}
	};

	private _onBlur = (): void => {
		this._inputFocused = false;
		this._open = false;
		this._highlight = -1;
		this._cancelPendingLookup(true);
	};

	private _onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "ArrowDown") {
			if (!this._open && this._suggestions.length === 0) {
				e.preventDefault();
				// Open with whatever we have (e.g. recent paths) on demand.
				this._scheduleLookup(true);
				return;
			}
			if (this._suggestions.length === 0) return;
			e.preventDefault();
			this._open = this._hasActiveInput();
			this._highlight = (this._highlight + 1) % this._suggestions.length;
			return;
		}
		if (e.key === "ArrowUp") {
			if (this._suggestions.length === 0) return;
			e.preventDefault();
			this._open = this._hasActiveInput();
			this._highlight =
				this._highlight <= 0
					? this._suggestions.length - 1
					: this._highlight - 1;
			return;
		}
		if (e.key === "Enter") {
			if (this._open && this._highlight >= 0 && this._highlight < this._suggestions.length) {
				e.preventDefault();
				const picked = this._suggestions[this._highlight];
				if (picked) this._pickSuggestion(picked);
				return;
			}
			// No highlight → commit current value.
			e.preventDefault();
			this._open = false;
			this._cancelPendingLookup(true);
			this._fire<DirectoryPickerPathDetail>("directory-commit", {
				path: this.value,
				source: "typed",
			});
			return;
		}
		if (e.key === "Escape") {
			if (this._open) {
				// Suggestions overlay open: swallow Esc so the surrounding dialog
				// (Mini-lit Dialog listens for Esc on `document`) does not also
				// close. Design doc: "Esc closes suggestions → browse → dialog
				// (in that order)". Pinned by
				// tests/e2e/ui/add-project-typeahead.spec.ts.
				e.preventDefault();
				e.stopPropagation();
				this._open = false;
				this._highlight = -1;
				this._cancelPendingLookup(true);
				return;
			}
			// Overlay already closed — propagate cancel up; the surrounding dialog
			// (parent dialog's onClose / directory-cancel listener) decides whether
			// to close itself.
			e.preventDefault();
			this._fire<void>("directory-cancel", undefined as unknown as void);
			return;
		}
		// Tab and other keys fall through normally.
	};

	private _pickSuggestion(s: DirectorySuggestion): void {
		this.setCompletedPath(s.path);
		this._fire<DirectoryPickerPathDetail>("directory-select", {
			path: s.path,
			source: "suggestion",
		});
		// Return focus to input.
		this.focusInput();
	}

	private _onSuggestionMouseDown = (e: MouseEvent, s: DirectorySuggestion): void => {
		// Use mousedown so we beat the input's blur handler.
		e.preventDefault();
		this._pickSuggestion(s);
	};

	private _onSuggestionHover = (idx: number): void => {
		this._highlight = idx;
	};

	private _onBrowseClick = (): void => {
		this._open = false;
		this._cancelPendingLookup(true);
		this._fire<DirectoryBrowseRequestDetail>("directory-browse-request", {
			path: this.value ?? "",
		});
	};

	// --- render -----------------------------------------------------------

	private _renderSuggestion(s: DirectorySuggestion, idx: number) {
		const active = idx === this._highlight;
		const baseRow =
			"flex items-baseline gap-2 px-3 py-1.5 text-sm cursor-pointer select-none";
		const stateRow = active
			? "bg-accent text-accent-foreground"
			: "text-foreground hover:bg-accent/60";
		return html`
			<li
				role="option"
				aria-selected=${active ? "true" : "false"}
				class="${baseRow} ${stateRow}"
				data-testid="directory-picker-suggestion"
				data-path=${s.path}
				@mousedown=${(e: MouseEvent) => this._onSuggestionMouseDown(e, s)}
				@mouseenter=${() => this._onSuggestionHover(idx)}
			>
				<span class="font-medium truncate">${s.name}</span>
				<span class="text-xs text-muted-foreground truncate flex-1" title=${s.path}>${s.path}</span>
				${s.hint
					? html`<span class="text-[10px] uppercase tracking-wide text-muted-foreground/80 shrink-0">${s.hint}</span>`
					: nothing}
			</li>
		`;
	}

	protected override render() {
		const inputClasses =
			"directory-picker-input flex w-full min-w-0 h-9 px-3 py-1 rounded-md border bg-transparent text-sm text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] dark:bg-input/30 border-input disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

		const browseBtnClasses =
			"shrink-0 h-9 px-3 inline-flex items-center justify-center rounded-md border border-border bg-transparent text-sm text-foreground hover:bg-secondary/50 transition-colors disabled:pointer-events-none disabled:opacity-50";

		const showSuggestions = this._inputFocused && this._open && this._suggestions.length > 0;

		return html`
			<div
				class="relative block w-full"
				data-testid="directory-picker"
			>
				<div class="flex items-stretch gap-2">
					<input
						class=${inputClasses}
						type="text"
						spellcheck="false"
						autocomplete="off"
						autocapitalize="off"
						autocorrect="off"
						.value=${this.value}
						placeholder=${this.placeholder}
						aria-label=${this.placeholder}
						?disabled=${this.disabled}
						aria-autocomplete="list"
						aria-expanded=${showSuggestions ? "true" : "false"}
						aria-controls="directory-picker-suggestions"
						aria-haspopup="listbox"
						data-testid="directory-picker-input"
						@input=${this._onInput}
						@focus=${this._onFocus}
						@blur=${this._onBlur}
						@keydown=${this._onKeyDown}
					/>
					${this.showBrowseButton
						? html`
							<button
								type="button"
								class=${browseBtnClasses}
								?disabled=${this.disabled}
								data-testid="directory-picker-browse"
								@click=${this._onBrowseClick}
							>
								Browse…
							</button>
						`
						: nothing}
				</div>
				${showSuggestions
					? html`
						<ul
							id="directory-picker-suggestions"
							role="listbox"
							class="absolute left-0 right-0 top-full mt-1 z-30 max-h-64 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
							data-testid="directory-picker-suggestions"
						>
							${this._suggestions.map((s, idx) => this._renderSuggestion(s, idx))}
						</ul>
					`
					: nothing}
				${this._loading && !showSuggestions
					? html`
						<div
							class="absolute left-0 right-0 top-full mt-1 z-30 px-3 py-1.5 text-xs text-muted-foreground bg-popover border border-border rounded-md shadow-sm pointer-events-none"
							data-testid="directory-picker-loading"
						>Searching…</div>
					`
					: nothing}
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"directory-picker": DirectoryPicker;
	}
}
