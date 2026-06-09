// src/ui/components/CommandPalette.ts
//
// CLIENT command-palette surface for pack `command-palette` launcher ENTRYPOINTS
// (Slice C1 — extension-host-phase2 §7 C1.3). This is the host surface that
// renders + runs `kind:"command-palette"` launchers, the peer of the composer
// slash menu (`composer-slash`, wired in MessageEditor) and the git-widget
// dropdown (`git-widget-button`, wired in GitStatusWidget). It consumes the SAME
// client pack-entrypoints registry: `listLauncherEntrypoints("command-palette")`
// to enumerate and `runLauncherEntrypoint(id)` to dispatch on a genuine user
// click (open panel / navigate). It NEVER auto-invokes a launcher on mount — a
// launcher fires only from a real click/Enter, whose transient activation is the
// user gesture (v1 §5 v); no `runWithUserGesture` wrapper is needed because the
// click itself carries activation.
//
// A single overlay instance is mounted lazily under <body> via
// `ensureCommandPalette()` (called from GitStatusWidget's connectedCallback so the
// surface exists wherever the session chrome renders, without forking the boot
// sequence). It opens on the `bobbit-open-command-palette` window event (dispatched
// e.g. from the git-widget dropdown's "Command palette" entry) — NOT on a global
// keyboard shortcut, since Ctrl/Cmd+K is already bound to sidebar search.

import { html, LitElement, nothing, render } from "lit";
import { customElement, state } from "lit/decorators.js";
import { listLauncherEntrypoints, runLauncherEntrypoint } from "../../app/pack-entrypoints.js";

/** The window event that opens the palette. Dispatch with no detail. */
export const OPEN_COMMAND_PALETTE_EVENT = "bobbit-open-command-palette";

interface PaletteItem {
	id: string;
	label: string;
}

@customElement("command-palette")
export class CommandPalette extends LitElement {
	@state() private _open = false;
	@state() private _filter = "";
	@state() private _items: PaletteItem[] = [];
	@state() private _highlight = 0;

	private _overlayEl: HTMLElement | null = null;

	// Light DOM so the theme tokens (var(--…)) resolve against the document.
	createRenderRoot() {
		return this;
	}

	private _onOpenEvent = () => this.open();
	private _onDocKeyDown = (e: KeyboardEvent) => this._handleKeyDown(e);

	connectedCallback() {
		super.connectedCallback();
		window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, this._onOpenEvent);
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, this._onOpenEvent);
		document.removeEventListener("keydown", this._onDocKeyDown, true);
		this._removeOverlay();
	}

	/** Open the palette. Snapshots the CURRENT registered command-palette launchers
	 *  (no invocation — purely a read) and shows the overlay. */
	open(): void {
		this._items = this._loadItems();
		this._filter = "";
		this._highlight = 0;
		this._open = true;
		document.addEventListener("keydown", this._onDocKeyDown, true);
		this._showOverlay();
		// Focus the filter input after the overlay renders.
		queueMicrotask(() => this._overlayEl?.querySelector<HTMLInputElement>("[data-testid='command-palette-input']")?.focus());
	}

	close(): void {
		if (!this._open) return;
		this._open = false;
		document.removeEventListener("keydown", this._onDocKeyDown, true);
		this._removeOverlay();
	}

	private _loadItems(): PaletteItem[] {
		try {
			return listLauncherEntrypoints("command-palette").map((l) => ({ id: l.id, label: l.label }));
		} catch {
			return [];
		}
	}

	private _filtered(): PaletteItem[] {
		const q = this._filter.trim().toLowerCase();
		if (!q) return this._items;
		return this._items.filter((i) => i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q));
	}

	private _handleKeyDown(e: KeyboardEvent): void {
		if (!this._open) return;
		const items = this._filtered();
		switch (e.key) {
			case "Escape":
				e.preventDefault();
				e.stopPropagation();
				this.close();
				return;
			case "ArrowDown":
				e.preventDefault();
				e.stopPropagation();
				if (items.length > 0) { this._highlight = (this._highlight + 1) % items.length; this._renderOverlay(); }
				return;
			case "ArrowUp":
				e.preventDefault();
				e.stopPropagation();
				if (items.length > 0) { this._highlight = (this._highlight - 1 + items.length) % items.length; this._renderOverlay(); }
				return;
			case "Enter": {
				e.preventDefault();
				e.stopPropagation();
				const sel = items[this._highlight];
				if (sel) this._run(sel.id);
				return;
			}
		}
	}

	/** Dispatch the launcher on a genuine user click/Enter. The click's transient
	 *  activation IS the user gesture — no runWithUserGesture wrapper needed. */
	private _run(id: string): void {
		this.close();
		try { runLauncherEntrypoint(id); } catch { /* non-fatal */ }
	}

	private _onFilterInput(e: Event): void {
		this._filter = (e.target as HTMLInputElement).value;
		this._highlight = 0;
		this._renderOverlay();
	}

	private _showOverlay(): void {
		this._removeOverlay();
		this._overlayEl = document.createElement("div");
		this._overlayEl.id = "command-palette-overlay";
		document.body.appendChild(this._overlayEl);
		this._renderOverlay();
	}

	private _renderOverlay(): void {
		if (!this._overlayEl) return;
		render(this._overlayTemplate(), this._overlayEl);
	}

	private _removeOverlay(): void {
		if (this._overlayEl) {
			this._overlayEl.remove();
			this._overlayEl = null;
		}
	}

	private _overlayTemplate() {
		const items = this._filtered();
		return html`
			<div
				data-testid="command-palette-backdrop"
				style="position:fixed;inset:0;z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 16px;background:rgba(0,0,0,0.4)"
				@click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this.close(); }}
			>
				<div
					data-testid="command-palette"
					role="dialog"
					aria-label="Command palette"
					style="width:100%;max-width:520px;display:flex;flex-direction:column;background:var(--popover, var(--card, var(--background)));color:var(--popover-foreground, var(--foreground));border:1px solid var(--border);border-radius:10px;overflow:hidden;box-shadow:0 25px 50px -12px rgba(0,0,0,0.35)"
				>
					<input
						data-testid="command-palette-input"
						type="text"
						placeholder="Run a command…"
						.value=${this._filter}
						@input=${(e: Event) => this._onFilterInput(e)}
						style="border:0;border-bottom:1px solid var(--border);background:transparent;color:inherit;font:inherit;padding:12px 14px;outline:none"
					/>
					<div data-testid="command-palette-list" style="max-height:50vh;overflow:auto;padding:6px">
						${items.length === 0
							? html`<div data-testid="command-palette-empty" style="padding:14px;color:var(--muted-foreground);font-size:13px">No commands available</div>`
							: items.map((item, i) => html`
								<button
									type="button"
									role="option"
									data-testid="command-palette-item"
									data-entrypoint-id=${item.id}
									aria-selected=${i === this._highlight ? "true" : "false"}
									@mouseenter=${() => { this._highlight = i; this._renderOverlay(); }}
									@click=${() => this._run(item.id)}
									style="display:flex;align-items:center;width:100%;text-align:left;gap:8px;padding:8px 10px;border:0;border-radius:6px;background:${i === this._highlight ? "var(--accent, rgba(127,127,127,0.15))" : "transparent"};color:inherit;font:inherit;cursor:pointer"
								>
									<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.label}</span>
								</button>
							`)}
					</div>
				</div>
			</div>
		`;
	}

	// The element is a behavior-only singleton; all visible UI lives in the
	// portaled overlay under <body>, so the element itself renders nothing.
	render() {
		return nothing;
	}
}

let _singleton: CommandPalette | null = null;

/** Mount the single command-palette overlay host under <body> exactly once. Safe
 *  to call repeatedly (idempotent). Returns the singleton instance. */
export function ensureCommandPalette(): CommandPalette {
	if (_singleton && _singleton.isConnected) return _singleton;
	if (typeof document === "undefined") {
		// SSR / non-DOM guard — never throws at import time.
		return (_singleton ??= new CommandPalette());
	}
	const existing = document.querySelector<CommandPalette>("command-palette");
	if (existing) { _singleton = existing; return existing; }
	const el = document.createElement("command-palette") as CommandPalette;
	document.body.appendChild(el);
	_singleton = el;
	return el;
}

/** Open the command palette from anywhere (e.g. a git-widget dropdown entry). */
export function openCommandPalette(): void {
	if (typeof window === "undefined") return;
	ensureCommandPalette();
	window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
}

declare global {
	interface HTMLElementTagNameMap {
		"command-palette": CommandPalette;
	}
}
