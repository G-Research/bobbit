import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

/**
 * Project info exposed to the picker. Callers pass the subset of their
 * `Project` that the picker renders.
 */
export interface ProjectPickerItem {
	id: string;
	name: string;
	colorLight?: string;
	colorDark?: string;
	color?: string;
}

/**
 * `<project-picker-popover>`
 *
 * A searchable, keyboard-navigable project picker. Anchored beneath
 * `anchorEl` on desktop; renders as a centered sheet on narrow viewports
 * (<640px).
 *
 * Events:
 *  - `project-pick`  detail: { projectId: string }  — user chose a project.
 *  - `close`                                        — user dismissed
 *      (Esc, click-outside, blur, empty-viewport).
 *
 * The consumer is responsible for mounting/unmounting the element and
 * listening for `close` to tear it down.
 */
@customElement("project-picker-popover")
export class ProjectPickerPopover extends LitElement {
	@property({ attribute: false }) projects: ProjectPickerItem[] = [];
	@property({ attribute: false }) anchorEl: HTMLElement | null = null;
	@property({ type: Boolean, reflect: true }) open = false;

	@state() private _query = "";
	@state() private _highlightIndex = 0;

	private _onDocPointerDown = (ev: PointerEvent) => this._handleDocPointerDown(ev);
	private _onDocKeyDown = (ev: KeyboardEvent) => this._handleDocKeyDown(ev);
	private _previousFocus: HTMLElement | null = null;
	private _listenersBound = false;

	// Light DOM — Tailwind/host CSS applies.
	override createRenderRoot() {
		return this;
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._unbindListeners();
	}

	override updated(changed: Map<string, unknown>) {
		if (changed.has("open")) {
			if (this.open) this._onOpen();
			else this._onClose();
		}
	}

	private _isMobile(): boolean {
		return typeof window !== "undefined" && window.innerWidth < 640;
	}

	private _onOpen() {
		this._previousFocus = (document.activeElement as HTMLElement) ?? null;
		this._highlightIndex = 0;
		this._bindListeners();
		// Focus the search input after render flushes.
		queueMicrotask(() => {
			const input = this.querySelector<HTMLInputElement>(".bobbit-project-picker-search");
			input?.focus();
		});
	}

	private _onClose() {
		this._unbindListeners();
		// Restore focus to the anchor (if provided) or previous focus.
		try {
			const target = this.anchorEl ?? this._previousFocus;
			if (target && typeof target.focus === "function") target.focus();
		} catch {
			// ignore
		}
		this._previousFocus = null;
	}

	private _bindListeners() {
		if (this._listenersBound) return;
		document.addEventListener("pointerdown", this._onDocPointerDown, true);
		document.addEventListener("keydown", this._onDocKeyDown, true);
		this._listenersBound = true;
	}

	private _unbindListeners() {
		if (!this._listenersBound) return;
		document.removeEventListener("pointerdown", this._onDocPointerDown, true);
		document.removeEventListener("keydown", this._onDocKeyDown, true);
		this._listenersBound = false;
	}

	private _handleDocPointerDown(ev: PointerEvent) {
		if (!this.open) return;
		const target = ev.target as Node | null;
		if (!target) return;
		// If the click/tap landed inside the popover root, ignore.
		if (this.contains(target)) return;
		// If it landed on the anchor, also ignore (consumer controls toggle).
		if (this.anchorEl && this.anchorEl.contains(target)) return;
		this._fireClose();
	}

	private _handleDocKeyDown(ev: KeyboardEvent) {
		if (!this.open) return;
		const filtered = this._filteredProjects();
		switch (ev.key) {
			case "Escape":
				ev.preventDefault();
				ev.stopPropagation();
				this._fireClose();
				return;
			case "ArrowDown":
				ev.preventDefault();
				if (filtered.length > 0) {
					this._highlightIndex = (this._highlightIndex + 1) % filtered.length;
				}
				return;
			case "ArrowUp":
				ev.preventDefault();
				if (filtered.length > 0) {
					this._highlightIndex = (this._highlightIndex - 1 + filtered.length) % filtered.length;
				}
				return;
			case "Enter": {
				if (filtered.length === 0) return;
				const pick = filtered[Math.max(0, Math.min(this._highlightIndex, filtered.length - 1))];
				if (pick) {
					ev.preventDefault();
					this._pick(pick.id);
				}
				return;
			}
		}
	}

	private _filteredProjects(): ProjectPickerItem[] {
		const q = this._query.trim().toLowerCase();
		if (!q) return this.projects;
		return this.projects.filter(p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
	}

	private _pick(projectId: string) {
		this.dispatchEvent(new CustomEvent("project-pick", {
			detail: { projectId },
			bubbles: true,
			composed: true,
		}));
	}

	private _fireClose() {
		this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
	}

	private _accent(p: ProjectPickerItem): string {
		const isDark = document.documentElement.classList.contains("dark");
		return (isDark ? (p.colorDark || p.colorLight) : (p.colorLight || p.colorDark)) || p.color || "var(--muted-foreground)";
	}

	private _computePosition(): { top: number; left: number; flipRight: boolean } {
		const anchor = this.anchorEl;
		const width = 280; // min-width for overflow calc
		if (!anchor || typeof anchor.getBoundingClientRect !== "function") {
			return { top: 16, left: 16, flipRight: false };
		}
		const rect = anchor.getBoundingClientRect();
		const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
		const top = rect.bottom + 4;
		let left = rect.left;
		let flipRight = false;
		if (left + width > vw - 8) {
			flipRight = true;
		}
		return { top, left, flipRight };
	}

	override render() {
		if (!this.open) return nothing;

		const filtered = this._filteredProjects();
		const mobile = this._isMobile();

		const row = (p: ProjectPickerItem, i: number) => {
			const highlighted = i === this._highlightIndex;
			const accent = this._accent(p);
			return html`
				<button
					type="button"
					role="option"
					data-project-id=${p.id}
					aria-selected=${highlighted ? "true" : "false"}
					class="bobbit-project-picker-row"
					style=${`display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:6px 10px;border:0;background:${highlighted ? "var(--accent, rgba(127,127,127,0.15))" : "transparent"};color:inherit;cursor:pointer;font-size:13px;border-radius:4px;`}
					@mouseenter=${() => { this._highlightIndex = i; }}
					@click=${() => this._pick(p.id)}
				>
					<span style=${`display:inline-block;width:10px;height:10px;border-radius:50%;background:${accent};flex-shrink:0;`}></span>
					<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</span>
				</button>
			`;
		};

		const searchInput = html`
			<div style="padding:8px 10px;border-bottom:1px solid var(--border);">
				<input
					type="text"
					class="bobbit-project-picker-search"
					placeholder="Search projects…"
					.value=${this._query}
					@input=${(e: Event) => {
						this._query = (e.target as HTMLInputElement).value;
						this._highlightIndex = 0;
					}}
					style="width:100%;padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:4px;background:var(--background, transparent);color:inherit;outline:none;"
				/>
			</div>
		`;

		const list = html`
			<div role="listbox" class="bobbit-project-picker-list" style="max-height:280px;overflow-y:auto;padding:4px;">
				${filtered.length === 0
					? html`<div style="padding:10px;font-size:12px;color:var(--muted-foreground);text-align:center;">No projects match "${this._query}"</div>`
					: filtered.map((p, i) => row(p, i))}
			</div>
		`;

		const card = html`
			<div
				class="bobbit-project-picker"
				role="dialog"
				aria-label="Select a project"
				@click=${(e: Event) => e.stopPropagation()}
				style="background:var(--popover, var(--background, #1a1a2e));color:var(--popover-foreground, inherit);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);min-width:260px;max-width:360px;font-size:13px;"
			>
				${searchInput}
				${list}
			</div>
		`;

		if (mobile) {
			return html`
				<div
					class="bobbit-project-picker-backdrop"
					style="position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;padding:16px;"
					@click=${(e: Event) => {
						if (e.target === e.currentTarget) this._fireClose();
					}}
				>
					<div style="width:100%;max-width:420px;">${card}</div>
				</div>
			`;
		}

		const { top, left, flipRight } = this._computePosition();
		const posStyle = flipRight
			? `position:fixed;top:${top}px;right:8px;z-index:50;`
			: `position:fixed;top:${top}px;left:${left}px;z-index:50;`;
		return html`<div style=${posStyle}>${card}</div>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"project-picker-popover": ProjectPickerPopover;
	}
}
