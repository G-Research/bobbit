import { html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
	computeSidebarActionFlipDeltas,
	type SidebarActionsFlipRect,
} from "./sidebar-actions-flip";

export type { SidebarActionsFlipRect } from "./sidebar-actions-flip";

/**
 * Optional checkbox rendered at the right edge of a menu row. Toggling it must
 * NOT activate the row's primary action and must NOT dismiss the popover —
 * only the row's main click/Enter fires the action, reading the toggle state.
 */
export interface SidebarActionsTrailingToggle {
	id: string;
	checked: boolean;
	ariaLabel: string;
	label?: string;
	onToggle: () => void;
}

export interface SidebarActionsPopoverItem {
	id: string;
	label: string;
	icon: TemplateResult;
	tone?: "default" | "danger";
	quick: boolean;
	trailingToggle?: SidebarActionsTrailingToggle;
}

export interface SidebarActionsSelectDetail {
	actionId: string;
}

export interface SidebarActionsPopoverPosition {
	top: number;
	left: number;
	placement: "bottom" | "top";
}

const VIEWPORT_PADDING = 8;
const ANCHOR_GAP = 6;
const OPEN_DURATION = 150;
const CLOSE_DURATION = 120;
// The shared-element FLIP travel runs slightly longer than the menu bloom so the
// quick icons clearly read as leaving the row and arriving in the menu.
const FLIP_OPEN_DURATION = 320;
const FLIP_CLOSE_DURATION = 220;
const FLIP_OPEN_EASING = "cubic-bezier(.22,.61,.36,1)"; // easeOutCubic-ish
const FLIP_CLOSE_EASING = "cubic-bezier(.55,.06,.68,.19)"; // easeInCubic-ish

export function computeSidebarActionsPopoverPosition(
	anchorRect: DOMRectReadOnly,
	menuSize: { width: number; height: number },
	viewport: { width: number; height: number },
): SidebarActionsPopoverPosition {
	const width = Math.max(0, menuSize.width);
	const height = Math.max(0, menuSize.height);
	const belowTop = anchorRect.bottom + ANCHOR_GAP;
	const aboveTop = anchorRect.top - ANCHOR_GAP - height;
	const belowSpace = viewport.height - VIEWPORT_PADDING - belowTop;
	const aboveSpace = anchorRect.top - VIEWPORT_PADDING - ANCHOR_GAP;
	const placement: "bottom" | "top" = belowSpace < height && aboveSpace > belowSpace ? "top" : "bottom";
	const unclampedTop = placement === "top" ? aboveTop : belowTop;
	const minTop = VIEWPORT_PADDING;
	const maxTop = Math.max(VIEWPORT_PADDING, viewport.height - VIEWPORT_PADDING - height);
	const top = Math.min(Math.max(unclampedTop, minTop), maxTop);
	const rightAlignedLeft = anchorRect.right - width;
	const maxLeft = Math.max(VIEWPORT_PADDING, viewport.width - VIEWPORT_PADDING - width);
	const left = Math.min(Math.max(rightAlignedLeft, VIEWPORT_PADDING), maxLeft);
	return { top, left, placement };
}

@customElement("sidebar-actions-popover")
export class SidebarActionsPopover extends LitElement {
	@property({ attribute: false }) items: SidebarActionsPopoverItem[] = [];
	@property({ attribute: false }) anchorEl: HTMLElement | null = null;
	@property({ attribute: false }) sourceRects: SidebarActionsFlipRect[] = [];
	@property({ type: Boolean, reflect: true }) open = false;

	@state() private _highlightIndex = 0;
	@state() private _closing = false;
	@state() private _position: SidebarActionsPopoverPosition = { top: VIEWPORT_PADDING, left: VIEWPORT_PADDING, placement: "bottom" };
	@state() private _maxHeight = 320;

	private _previousFocus: HTMLElement | null = null;
	private _rowStrip: HTMLElement | null = null;
	private _listenersBound = false;
	private _animations: Animation[] = [];
	private _closeRequested = false;
	private _openedToken = 0;
	private _finishingInternalClose = false;

	private _onDocPointerDown = (ev: PointerEvent) => this._handleDocPointerDown(ev);
	private _onDocKeyDown = (ev: KeyboardEvent) => this._handleDocKeyDown(ev);
	private _onRouteChange = () => this._requestClose();
	private _onViewportChange = () => this._measureAndPosition();

	override createRenderRoot() {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "contents";
		this._syncPopoverOpenAttr();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._unbindListeners();
		this._cancelAnimations();
		this._restoreRowStrip();
		this.removeAttribute("data-popover-open");
	}

	override willUpdate(changed: PropertyValues<this>): void {
		if (changed.has("open") && changed.get("open") === true && !this.open && !this._finishingInternalClose && !this._closing) {
			this._closing = true;
			this._closeRequested = true;
			this._syncPopoverOpenAttr();
		}
	}

	override updated(changed: PropertyValues<this>): void {
		if (changed.has("open")) {
			if (this.open) this._onOpen();
			else if (!this._finishingInternalClose) {
				if (this._closing) this._onExternalCloseWithAnimation();
				else this._onExternalClose();
			}
		}
		if (changed.has("items")) {
			this._highlightIndex = this._clampIndex(this._highlightIndex);
			if (this.open) queueMicrotask(() => this._measureAndPosition());
		}
		this._syncPopoverOpenAttr();
	}

	private _onOpen(): void {
		this._openedToken += 1;
		this._closeRequested = false;
		this._closing = false;
		this._cancelAnimations();
		this._previousFocus = (document.activeElement as HTMLElement | null) ?? null;
		this._rowStrip = this._resolveRowStrip();
		this._highlightIndex = this.items.length > 0 ? this._clampIndex(this._highlightIndex) : -1;
		this._bindListeners();
		this._syncPopoverOpenAttr();
		void this._afterOpenRender(this._openedToken);
	}

	private _onExternalClose(): void {
		this._closeRequested = false;
		this._closing = false;
		this._unbindListeners();
		this._cancelAnimations();
		this._restoreRowStrip();
		this._restoreFocus();
		this._syncPopoverOpenAttr();
	}

	private _onExternalCloseWithAnimation(): void {
		this._unbindListeners();
		this._syncPopoverOpenAttr();
		if (this._prefersReducedMotion()) {
			this._finishExternalClose();
			return;
		}
		void this._animateClose().finally(() => this._finishExternalClose());
	}

	private _finishExternalClose(): void {
		this._closeRequested = false;
		this._closing = false;
		this._cancelAnimations();
		this._restoreRowStrip();
		this._restoreFocus();
		this._syncPopoverOpenAttr();
		this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
		this.requestUpdate();
	}

	private async _afterOpenRender(token: number): Promise<void> {
		await this.updateComplete;
		if (!this.open || token !== this._openedToken) return;
		this._measureAndPosition();
		await this.updateComplete;
		if (!this.open || token !== this._openedToken) return;
		this._focusHighlighted();
		this._animateOpen();
	}

	private _bindListeners(): void {
		if (this._listenersBound) return;
		document.addEventListener("pointerdown", this._onDocPointerDown, true);
		document.addEventListener("keydown", this._onDocKeyDown, true);
		window.addEventListener("hashchange", this._onRouteChange);
		window.addEventListener("popstate", this._onRouteChange);
		window.addEventListener("resize", this._onViewportChange);
		window.addEventListener("scroll", this._onViewportChange, true);
		this._listenersBound = true;
	}

	private _unbindListeners(): void {
		if (!this._listenersBound) return;
		document.removeEventListener("pointerdown", this._onDocPointerDown, true);
		document.removeEventListener("keydown", this._onDocKeyDown, true);
		window.removeEventListener("hashchange", this._onRouteChange);
		window.removeEventListener("popstate", this._onRouteChange);
		window.removeEventListener("resize", this._onViewportChange);
		window.removeEventListener("scroll", this._onViewportChange, true);
		this._listenersBound = false;
	}

	private _handleDocPointerDown(ev: PointerEvent): void {
		if (!this.open || this._closing) return;
		const target = ev.target as Node | null;
		if (!target) return;
		if (this.contains(target)) return;
		if (this.anchorEl?.contains(target)) return;
		this._requestClose();
	}

	private _handleDocKeyDown(ev: KeyboardEvent): void {
		if (!this.open || this._closing) return;
		switch (ev.key) {
			case "Escape":
				ev.preventDefault();
				ev.stopPropagation();
				this._requestClose();
				return;
			case "ArrowDown":
				ev.preventDefault();
				ev.stopPropagation();
				this._moveHighlight(1);
				return;
			case "ArrowUp":
				ev.preventDefault();
				ev.stopPropagation();
				this._moveHighlight(-1);
				return;
			case "Home":
				ev.preventDefault();
				ev.stopPropagation();
				this._setHighlight(0);
				return;
			case "End":
				ev.preventDefault();
				ev.stopPropagation();
				this._setHighlight(this.items.length - 1);
				return;
			case "Enter":
				ev.preventDefault();
				ev.stopPropagation();
				this._selectHighlighted(ev);
				return;
			case " ":
				ev.preventDefault();
				ev.stopPropagation();
				// Space toggles the highlighted row's trailing checkbox when it has
				// one (or the checkbox control itself when focused) without firing
				// the row's action or closing the menu. Otherwise it activates.
				if (this._toggleFromKeyboard()) return;
				this._selectHighlighted(ev);
				return;
			case "Tab":
				setTimeout(() => this._requestClose(false), 0);
				return;
		}
	}

	private _requestClose(restoreFocus = true): void {
		if (!this.open || this._closeRequested) return;
		this._closeRequested = true;
		this._closing = true;
		this._syncPopoverOpenAttr();
		this._unbindListeners();
		if (this._prefersReducedMotion()) {
			this._finishClose(restoreFocus);
			return;
		}
		void this._animateClose().finally(() => this._finishClose(restoreFocus));
	}

	private _finishClose(restoreFocus: boolean): void {
		this._finishingInternalClose = true;
		this.open = false;
		this._closing = false;
		this._closeRequested = false;
		this._cancelAnimations();
		this._restoreRowStrip();
		this._syncPopoverOpenAttr();
		if (restoreFocus) this._restoreFocus();
		this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
		queueMicrotask(() => { this._finishingInternalClose = false; });
	}

	/**
	 * The row's on-screen quick-action strip. While the menu blooms we fade ONLY
	 * the quick-action buttons inside it so their icons read as travelling into
	 * the popover (shared element). The hamburger trigger stays fully visible the
	 * entire time the menu is open. The strip lives in the light DOM next to the
	 * trigger; visibility is otherwise governed by group-hover/focus CSS.
	 */
	private _resolveRowStrip(): HTMLElement | null {
		const root = this.anchorEl?.closest<HTMLElement>("[data-sidebar-actions-row-root]") ?? null;
		return root?.querySelector<HTMLElement>(".sidebar-actions") ?? null;
	}

	/** Quick-action buttons inside the row strip (excludes the hamburger trigger). */
	private _rowQuickButtons(): HTMLElement[] {
		if (!this._rowStrip) return [];
		return [...this._rowStrip.querySelectorAll<HTMLElement>("[data-sidebar-action-quick='true']")];
	}

	private _restoreRowStrip(): void {
		for (const btn of this._rowQuickButtons()) btn.style.removeProperty("opacity");
		this._rowStrip = null;
	}

	private _restoreFocus(): void {
		try {
			const target = this.anchorEl ?? this._previousFocus;
			if (target && typeof target.focus === "function") target.focus();
		} catch {
			// Ignore focus races during route changes/unmount.
		}
		this._previousFocus = null;
	}

	private _syncPopoverOpenAttr(): void {
		if (this.open || this._closing) this.setAttribute("data-popover-open", "");
		else this.removeAttribute("data-popover-open");
	}

	private _clampIndex(index: number): number {
		if (this.items.length === 0) return -1;
		return Math.min(Math.max(index, 0), this.items.length - 1);
	}

	private _moveHighlight(delta: number): void {
		if (this.items.length === 0) return;
		const current = this._highlightIndex < 0 ? 0 : this._highlightIndex;
		this._setHighlight((current + delta + this.items.length) % this.items.length);
	}

	private _setHighlight(index: number): void {
		this._highlightIndex = this._clampIndex(index);
		this.updateComplete.then(() => this._focusHighlighted()).catch(() => undefined);
	}

	private _focusHighlighted(): void {
		const item = this._highlightedButton();
		if (item) item.focus({ preventScroll: true });
		else this.querySelector<HTMLElement>(".bobbit-sidebar-actions-menu")?.focus({ preventScroll: true });
	}

	private _highlightedButton(): HTMLButtonElement | null {
		if (this._highlightIndex < 0) return null;
		return this.querySelector<HTMLButtonElement>(`button[data-sidebar-actions-index="${this._highlightIndex}"]`);
	}

	private _selectHighlighted(event: Event): void {
		const item = this.items[this._highlightIndex];
		if (item) this._select(item.id, event);
	}

	/**
	 * Toggle a trailing checkbox from the keyboard. Targets the focused checkbox
	 * control when one is focused, else the highlighted row's checkbox. Returns
	 * true when a toggle fired (so the caller skips the row activation path).
	 */
	private _toggleFromKeyboard(): boolean {
		if (this._closeRequested) return false;
		const active = document.activeElement as HTMLElement | null;
		if (active && this.contains(active) && active.dataset?.sidebarActionsToggle != null) {
			const id = active.dataset.sidebarActionId;
			const fromControl = this.items.find((i) => i.id === id);
			if (fromControl?.trailingToggle) { fromControl.trailingToggle.onToggle(); return true; }
		}
		const item = this.items[this._highlightIndex];
		if (item?.trailingToggle) { item.trailingToggle.onToggle(); return true; }
		return false;
	}

	private _handleToggle(item: SidebarActionsPopoverItem, event: Event): void {
		event.preventDefault();
		event.stopPropagation();
		if (this._closeRequested || !item.trailingToggle) return;
		item.trailingToggle.onToggle();
	}

	private _select(actionId: string, event: Event): void {
		event.stopPropagation();
		if (this._closeRequested) return;
		this.dispatchEvent(new CustomEvent<SidebarActionsSelectDetail>("sidebar-action-select", {
			detail: { actionId },
			bubbles: true,
			composed: true,
		}));
		this._requestClose();
	}

	private _measureAndPosition(): void {
		if (!this.open || !this.anchorEl || typeof this.anchorEl.getBoundingClientRect !== "function") return;
		const menu = this.querySelector<HTMLElement>(".bobbit-sidebar-actions-menu");
		const width = Math.max(menu?.offsetWidth ?? 0, 208);
		const estimatedHeight = Math.max(this.items.length * 36 + 8, 44);
		const height = Math.max(menu?.offsetHeight ?? 0, estimatedHeight);
		const viewport = {
			width: window.innerWidth || document.documentElement.clientWidth || 1024,
			height: window.innerHeight || document.documentElement.clientHeight || 768,
		};
		const anchorRect = this.anchorEl.getBoundingClientRect();
		const position = computeSidebarActionsPopoverPosition(anchorRect, { width, height }, viewport);
		const available = position.placement === "top"
			? Math.max(44, anchorRect.top - VIEWPORT_PADDING - ANCHOR_GAP)
			: Math.max(44, viewport.height - position.top - VIEWPORT_PADDING);
		this._position = position;
		this._maxHeight = Math.floor(available);
	}

	private _prefersReducedMotion(): boolean {
		return typeof window !== "undefined"
			&& typeof window.matchMedia === "function"
			&& window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	}

	private _animateOpen(): void {
		if (this._prefersReducedMotion()) return;
		this._cancelAnimations();

		// Fade ONLY the row's quick-action buttons out so their icons appear to leave
		// the row and arrive in the menu (shared-element illusion). The hamburger
		// trigger stays fully visible while the menu is open.
		for (const btn of this._rowQuickButtons()) {
			if (typeof btn.animate !== "function") { btn.style.opacity = "0"; continue; }
			btn.style.opacity = "1";
			const btnAnim = btn.animate([{ opacity: 1 }, { opacity: 0 }], {
				duration: OPEN_DURATION,
				easing: "ease-out",
				fill: "forwards",
			});
			btnAnim.finished.then(() => { btn.style.opacity = "0"; }).catch(() => undefined);
			this._animations.push(btnAnim);
		}

		// Bloom the menu surface.
		const menu = this.querySelector<HTMLElement>(".bobbit-sidebar-actions-menu");
		if (menu && typeof menu.animate === "function") {
			menu.style.transformOrigin = this._position.placement === "top" ? "bottom right" : "top right";
			this._animations.push(menu.animate([
				{ opacity: 0, transform: "scale(0.96)" },
				{ opacity: 1, transform: "scale(1)" },
			], { duration: OPEN_DURATION, easing: "cubic-bezier(.2, .8, .2, 1)", fill: "backwards" }));
		}

		// Shared-element FLIP: each quick icon travels from its row position into
		// its menu slot. Compounding with the menu scale is negligible at this size.
		const targets = this._targetQuickIconRects();
		const deltas = computeSidebarActionFlipDeltas(this.sourceRects, targets);
		for (const delta of deltas) {
			const icon = this._quickIcon(delta.actionId);
			if (!icon || typeof icon.animate !== "function") continue;
			const animation = icon.animate([
				{ transform: `translate(${delta.dx}px, ${delta.dy}px) scale(${delta.sx}, ${delta.sy})` },
				{ transform: "translate(0, 0) scale(1, 1)" },
			], { duration: FLIP_OPEN_DURATION, easing: FLIP_OPEN_EASING, fill: "backwards" });
			this._animations.push(animation);
		}

		// Labels of quick rows catch up to the arriving icons.
		this._quickRowLabels().forEach((label) => {
			if (typeof label.animate !== "function") return;
			this._animations.push(label.animate([
				{ opacity: 0 },
				{ opacity: 1 },
			], { duration: OPEN_DURATION, delay: 50, easing: "ease-out", fill: "backwards" }));
		});

		// Menu-only rows (no row counterpart) stagger in alongside.
		this._menuOnlyRows().forEach((row, index) => {
			if (typeof row.animate !== "function") return;
			this._animations.push(row.animate([
				{ opacity: 0, transform: "translateY(-0.25em)" },
				{ opacity: 1, transform: "translateY(0)" },
			], { duration: OPEN_DURATION, delay: 55 + index * 25, easing: "ease-out", fill: "backwards" }));
		});
	}

	private async _animateClose(): Promise<void> {
		this._cancelAnimations();
		const animations: Animation[] = [];

		// Reverse FLIP: icons travel back toward their row positions.
		const targets = this._targetQuickIconRects();
		const deltas = computeSidebarActionFlipDeltas(this.sourceRects, targets);
		for (const delta of deltas) {
			const icon = this._quickIcon(delta.actionId);
			if (!icon || typeof icon.animate !== "function") continue;
			animations.push(icon.animate([
				{ transform: "translate(0, 0) scale(1, 1)" },
				{ transform: `translate(${delta.dx}px, ${delta.dy}px) scale(${delta.sx}, ${delta.sy})` },
			], { duration: FLIP_CLOSE_DURATION, easing: FLIP_CLOSE_EASING, fill: "forwards" }));
		}
		for (const row of this._menuOnlyRows()) {
			if (typeof row.animate !== "function") continue;
			animations.push(row.animate([
				{ opacity: 1, transform: "translateY(0)" },
				{ opacity: 0, transform: "translateY(-0.25em)" },
			], { duration: CLOSE_DURATION, easing: "ease-in", fill: "forwards" }));
		}

		// Collapse the menu surface as the icons return to the row.
		const menu = this.querySelector<HTMLElement>(".bobbit-sidebar-actions-menu");
		if (menu && typeof menu.animate === "function") {
			menu.style.transformOrigin = this._position.placement === "top" ? "bottom right" : "top right";
			animations.push(menu.animate([
				{ opacity: 1, transform: "scale(1)" },
				{ opacity: 0, transform: "scale(0.96)" },
			], { duration: CLOSE_DURATION, easing: "ease-in", fill: "forwards" }));
		}

		// Bring the row's quick-action buttons back as the popover unwinds. The
		// hamburger trigger was never faded, so it needs no restore here.
		for (const btn of this._rowQuickButtons()) {
			if (typeof btn.animate !== "function") { btn.style.removeProperty("opacity"); continue; }
			btn.style.opacity = "0";
			const btnAnim = btn.animate([{ opacity: 0 }, { opacity: 1 }], {
				duration: CLOSE_DURATION,
				easing: "ease-in",
				fill: "forwards",
			});
			btnAnim.finished.then(() => btn.style.removeProperty("opacity")).catch(() => undefined);
			animations.push(btnAnim);
		}

		this._animations = animations;
		await Promise.allSettled(animations.map((animation) => animation.finished));
	}

	private _cancelAnimations(): void {
		for (const animation of this._animations) {
			try { animation.cancel(); } catch { /* ignore */ }
		}
		this._animations = [];
	}

	private _targetQuickIconRects(): SidebarActionsFlipRect[] {
		return this._quickIcons().map((icon) => ({
			actionId: icon.dataset.sidebarActionId!,
			rect: icon.getBoundingClientRect(),
		}));
	}

	private _quickIcons(): HTMLElement[] {
		return [...this.querySelectorAll<HTMLElement>("[data-sidebar-actions-popover-icon][data-sidebar-action-quick='true'][data-sidebar-action-id]")];
	}

	private _quickIcon(actionId: string): HTMLElement | null {
		return this._quickIcons().find((icon) => icon.dataset.sidebarActionId === actionId) ?? null;
	}

	private _menuOnlyRows(): HTMLElement[] {
		return [...this.querySelectorAll<HTMLElement>("[data-sidebar-actions-row][data-sidebar-action-quick='false']")];
	}

	private _quickRowLabels(): HTMLElement[] {
		return [...this.querySelectorAll<HTMLElement>("[data-sidebar-actions-row][data-sidebar-action-quick='true'] [data-sidebar-actions-label]")];
	}

	override render() {
		if (!this.open && !this._closing) return nothing;

		const position = this._position;
		const layerStyle = [
			"position:fixed",
			`top:${position.top}px`,
			`left:${position.left}px`,
			"z-index:60",
			"min-width:13em",
			"max-width:min(20em, calc(100vw - 1em))",
		].join(";");

		return html`
			<div class="bobbit-sidebar-actions-layer" style=${layerStyle} @click=${(e: Event) => e.stopPropagation()}>
				<div
					class="bobbit-sidebar-actions-menu"
					role="menu"
					tabindex="-1"
					data-placement=${position.placement}
					style=${`box-sizing:border-box;display:flex;flex-direction:column;gap:2px;max-height:${this._maxHeight}px;overflow:auto;padding:4px;border:1px solid var(--border);border-radius:8px;background:var(--popover, var(--background));color:var(--popover-foreground, inherit);box-shadow:0 4px 12px rgba(0,0,0,0.15);font-size:calc(13px * var(--sidebar-font-scale, 1));outline:none;`}
					@keydown=${(e: KeyboardEvent) => e.stopPropagation()}
				>
					${this.items.map((item, index) => this._renderItem(item, index))}
				</div>
			</div>
		`;
	}

	private _renderItem(item: SidebarActionsPopoverItem, index: number): TemplateResult {
		const highlighted = index === this._highlightIndex;
		const danger = item.tone === "danger";
		const color = danger ? "var(--negative, var(--destructive, currentColor))" : "inherit";
		const background = highlighted ? "var(--accent, rgba(127,127,127,0.15))" : "transparent";
		const hasToggle = !!item.trailingToggle;
		const button = html`
			<button
				type="button"
				role="menuitem"
				data-sidebar-actions-row
				data-sidebar-actions-index=${index}
				data-sidebar-action-id=${item.id}
				data-sidebar-action-quick=${item.quick ? "true" : "false"}
				tabindex=${highlighted ? "0" : "-1"}
				class="bobbit-sidebar-actions-row"
				style=${`display:flex;align-items:center;gap:8px;${hasToggle ? "flex:1;" : "width:100%;"}min-width:0;padding:6px 10px;border:0;border-radius:4px;background:${background};color:${color};font:inherit;line-height:1.2;text-align:left;cursor:pointer;`}
				@mouseenter=${() => { this._highlightIndex = index; }}
				@click=${(event: Event) => this._select(item.id, event)}
			>
				<span
					data-sidebar-actions-popover-icon
					data-sidebar-action-id=${item.id}
					data-sidebar-action-quick=${item.quick ? "true" : "false"}
					style="display:inline-flex;align-items:center;justify-content:center;width:1.2em;height:1.2em;flex:0 0 auto;transform-origin:top left;"
				>${item.icon}</span>
				<span data-sidebar-actions-label style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${item.label}</span>
			</button>
		`;
		if (!hasToggle) return button;
		const toggle = item.trailingToggle!;
		return html`
			<div
				role="none"
				class="bobbit-sidebar-actions-toggle-row"
				style=${`display:flex;align-items:stretch;gap:2px;width:100%;min-width:0;border-radius:4px;background:${background};`}
				@mouseenter=${() => { this._highlightIndex = index; }}
			>
				${button}
				<span
					role="menuitemcheckbox"
					data-sidebar-actions-toggle
					data-sidebar-action-id=${item.id}
					aria-checked=${toggle.checked ? "true" : "false"}
					aria-label=${toggle.ariaLabel}
					title=${toggle.ariaLabel}
					tabindex="-1"
					style="display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;padding:6px 10px 6px 8px;border-radius:4px;cursor:pointer;color:var(--muted-foreground, inherit);font:inherit;line-height:1.2;white-space:nowrap;"
					@mouseenter=${(e: Event) => { e.stopPropagation(); }}
					@click=${(event: Event) => this._handleToggle(item, event)}
					@keydown=${(event: KeyboardEvent) => { if (event.key === " " || event.key === "Enter") this._handleToggle(item, event); }}
				>
					<input
						type="checkbox"
						class="toggle-switch"
						.checked=${toggle.checked}
						aria-hidden="true"
						tabindex="-1"
						style="pointer-events:none;flex:0 0 auto;"
					/>
					${toggle.label ? html`<span style="overflow:hidden;text-overflow:ellipsis;">${toggle.label}</span>` : nothing}
				</span>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"sidebar-actions-popover": SidebarActionsPopover;
	}
}
