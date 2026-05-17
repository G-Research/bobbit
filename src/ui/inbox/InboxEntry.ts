import { html, LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { InboxEntry } from "../../server/agent/inbox-store.js";

/**
 * <inbox-entry-row> — single row in the inbox panel.
 *
 * Renders title, source badge, age, state pill, and per-state actions:
 *   - pending entries get a "Cancel" action (POSTs /inbox/:entryId/dismiss
 *     with outcome=cancelled).
 *   - terminal entries get a "Delete" action (DELETEs the entry).
 *
 * The component is purely presentational + dispatches CustomEvents; the
 * parent (`<inbox-panel>`) owns the HTTP calls and reacts via WS events.
 *
 * Light DOM (createRenderRoot returns `this`) — re-uses the app's design
 * tokens directly. No prefers-color-scheme; uses CSS custom properties
 * inherited from the host.
 */
@customElement("inbox-entry-row")
export class InboxEntryRow extends LitElement {
	@property({ attribute: false })
	entry!: InboxEntry;

	@property({ type: Boolean })
	busy = false;

	static styles = css`
		:host {
			display: block;
		}
	`;

	createRenderRoot() {
		return this;
	}

	updated(changedProps: Map<string, unknown>): void {
		super.updated(changedProps);
		// Reflect entry.state to the host as `data-state` so external selectors
		// (Playwright tests, CSS) can target rows by lifecycle state without
		// piercing into the light-DOM children.
		if (this.entry?.state) this.setAttribute("data-state", this.entry.state);
		if (this.entry?.id) this.setAttribute("data-entry-id", this.entry.id);
	}

	private _emit(eventName: string): void {
		this.dispatchEvent(new CustomEvent(eventName, {
			detail: { entryId: this.entry.id },
			bubbles: true,
			composed: true,
		}));
	}

	private _sourceBadge(): string {
		const t = this.entry.source?.type;
		if (t === "trigger") return "trigger";
		if (t === "manual_ui") return "manual";
		if (t === "manual_api") return "api";
		return "?";
	}

	private _statePillClass(): string {
		switch (this.entry.state) {
			case "pending":   return "inbox-pill inbox-pill--pending";
			case "completed": return "inbox-pill inbox-pill--completed";
			case "failed":    return "inbox-pill inbox-pill--failed";
			case "cancelled": return "inbox-pill inbox-pill--cancelled";
			default:          return "inbox-pill";
		}
	}

	private _relativeAge(): string {
		const ms = Date.now() - (this.entry.createdAt || 0);
		if (ms < 60_000) return "just now";
		if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
		if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
		return `${Math.floor(ms / 86_400_000)}d ago`;
	}

	render() {
		const isPending = this.entry.state === "pending";
		return html`
			<div
				class="inbox-row"
				data-entry-id=${this.entry.id}
				data-state=${this.entry.state}
				style="display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--card,var(--background));"
			>
				<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
					<span style="font-weight:500;font-size:13px;color:var(--foreground);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=${this.entry.title}>
						${this.entry.title}
					</span>
					<span class=${this._statePillClass()} style="font-size:10px;padding:1px 6px;border-radius:999px;background:color-mix(in oklch, var(--muted-foreground) 15%, transparent);color:var(--muted-foreground);text-transform:uppercase;letter-spacing:0.04em;">
						${this.entry.state}
					</span>
				</div>
				<div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted-foreground);flex-wrap:wrap;">
					<span class="inbox-source-badge" style="padding:1px 5px;border-radius:4px;background:color-mix(in oklch, var(--chart-2) 18%, transparent);color:var(--foreground);font-size:10px;">
						${this._sourceBadge()}
					</span>
					<span class="inbox-age" title=${new Date(this.entry.createdAt || 0).toISOString()}>${this._relativeAge()}</span>
					${this.entry.result
						? html`<span class="inbox-result" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=${this.entry.result}>${this.entry.result}</span>`
						: ""}
					${this.entry.error
						? html`<span class="inbox-error" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--negative,var(--destructive));" title=${this.entry.error}>${this.entry.error}</span>`
						: ""}
					<span style="flex:1;"></span>
					${isPending
						? html`<button
								class="inbox-cancel-btn"
								?disabled=${this.busy}
								@click=${() => this._emit("inbox-cancel")}
								style="font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--muted-foreground);cursor:pointer;"
								title="Cancel this entry"
							>Cancel</button>`
						: html`<button
								class="inbox-delete-btn"
								?disabled=${this.busy}
								@click=${() => this._emit("inbox-delete")}
								style="font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--muted-foreground);cursor:pointer;"
								title="Delete from history"
							>Delete</button>`
					}
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"inbox-entry-row": InboxEntryRow;
	}
}
