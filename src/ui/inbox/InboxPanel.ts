import { html, LitElement, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { InboxEntry } from "../../server/agent/inbox-store.js";
import "./InboxEntry.js";
import "./AddToInboxDialog.js";

/**
 * <inbox-panel> — split-pane content for staff session views.
 *
 * Renders two sections:
 *   - Pending: live entries the agent has yet to process. Each row has a
 *     "Cancel" action.
 *   - History (collapsible <details>): all terminal-state entries
 *     (completed / failed / cancelled), newest first. Per-entry delete.
 *
 * A "+ Add to inbox" button opens <add-to-inbox-dialog>, which POSTs the
 * new entry; the resulting WS event renders it into Pending.
 *
 * Mirrors `src/ui/components/review/ReviewPane.ts` in shape (LitElement,
 * light DOM, custom event dispatch). Action handlers POST to the REST
 * surface documented in `docs/design/staff-inbox.md` §7.1.
 */
@customElement("inbox-panel")
export class InboxPanel extends LitElement {
	@property({ attribute: false })
	entries: InboxEntry[] = [];

	@property({ type: String })
	staffId = "";

	@property({ type: String })
	sessionId = "";

	@property({ type: Boolean })
	addDialogOpen = false;

	@state() private _historyOpen = false;
	@state() private _busyEntryIds = new Set<string>();

	static styles = css`
		:host {
			display: flex;
			flex-direction: column;
			min-height: 0;
			height: 100%;
		}
	`;

	createRenderRoot() {
		return this;
	}

	private _markBusy(id: string, busy: boolean): void {
		const next = new Set(this._busyEntryIds);
		if (busy) next.add(id); else next.delete(id);
		this._busyEntryIds = next;
	}

	private async _cancel(entryId: string): Promise<void> {
		this._markBusy(entryId, true);
		try {
			await fetch(
				`/api/staff/${encodeURIComponent(this.staffId)}/inbox/${encodeURIComponent(entryId)}/dismiss`,
				{
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sessionId: this.sessionId,
						outcome: "cancelled",
						reason: "Cancelled from UI",
					}),
				},
			);
		} finally {
			this._markBusy(entryId, false);
		}
	}

	private async _delete(entryId: string): Promise<void> {
		this._markBusy(entryId, true);
		try {
			await fetch(
				`/api/staff/${encodeURIComponent(this.staffId)}/inbox/${encodeURIComponent(entryId)}`,
				{ method: "DELETE", credentials: "include" },
			);
		} finally {
			this._markBusy(entryId, false);
		}
	}

	private _openAddDialog(): void {
		this.dispatchEvent(new CustomEvent("inbox-open-add", { bubbles: true, composed: true }));
	}

	private _closeAddDialog(): void {
		this.dispatchEvent(new CustomEvent("inbox-add-close", { bubbles: true, composed: true }));
	}

	private _onEntryAction(eventName: "inbox-cancel" | "inbox-delete", entryId: string): void {
		if (eventName === "inbox-cancel") void this._cancel(entryId);
		else void this._delete(entryId);
	}

	render() {
		const pending = this.entries.filter((e) => e.state === "pending");
		const terminal = this.entries
			.filter((e) => e.state !== "pending")
			.sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt));

		const isEmpty = pending.length === 0 && terminal.length === 0;

		return html`
			<div class="inbox-panel" style="position:relative;overflow:hidden;display:flex;flex-direction:column;height:100%;min-height:0;">
				<div class="inbox-panel-header" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0;">
					<div style="font-size:13px;font-weight:600;color:var(--foreground);">Inbox</div>
					<button
						class="inbox-add-btn"
						@click=${this._openAddDialog}
						style="font-size:12px;padding:4px 10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--foreground);cursor:pointer;"
						title="Add a manual inbox entry"
					>+ Add to inbox</button>
				</div>

				<div class="inbox-panel-body" style="flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:14px;">
					${isEmpty
						? html`<div class="inbox-empty" style="text-align:center;color:var(--muted-foreground);font-size:13px;padding:24px 12px;">
								<div style="margin-bottom:6px;">No inbox entries yet</div>
								<div style="font-size:11px;">Triggers or the "+ Add to inbox" button will queue work for this staff agent.</div>
							</div>`
						: html`
							<section class="inbox-section inbox-pending-section" data-section="pending">
								<header style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted-foreground);margin-bottom:6px;">
									Pending ${pending.length > 0 ? html`<span style="font-weight:600;">(${pending.length})</span>` : ""}
								</header>
								${pending.length === 0
									? html`<div style="font-size:12px;color:var(--muted-foreground);padding:4px 0;">No pending entries.</div>`
									: html`
										<div style="display:flex;flex-direction:column;gap:6px;">
											${pending.map((e) => html`
												<inbox-entry-row
													.entry=${e}
													.busy=${this._busyEntryIds.has(e.id)}
													@inbox-cancel=${() => this._onEntryAction("inbox-cancel", e.id)}
													@inbox-delete=${() => this._onEntryAction("inbox-delete", e.id)}
												></inbox-entry-row>
											`)}
										</div>
									`}
							</section>

							${terminal.length > 0
								? html`
									<section class="inbox-section inbox-history-section" data-section="history">
										<details
											?open=${this._historyOpen}
											@toggle=${(e: Event) => { this._historyOpen = (e.target as HTMLDetailsElement).open; }}
										>
											<summary style="cursor:pointer;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted-foreground);margin-bottom:6px;list-style:revert;">
												History <span style="font-weight:600;">(${terminal.length})</span>
											</summary>
											<div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
												${terminal.map((e) => html`
													<inbox-entry-row
														.entry=${e}
														.busy=${this._busyEntryIds.has(e.id)}
														@inbox-cancel=${() => this._onEntryAction("inbox-cancel", e.id)}
														@inbox-delete=${() => this._onEntryAction("inbox-delete", e.id)}
													></inbox-entry-row>
												`)}
											</div>
										</details>
									</section>
								`
								: ""
							}
						`
					}
				</div>

				${this.addDialogOpen
					? html`<add-to-inbox-dialog
							.staffId=${this.staffId}
							@inbox-add-close=${this._closeAddDialog}
							@inbox-add-submitted=${this._closeAddDialog}
						></add-to-inbox-dialog>`
					: ""}
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"inbox-panel": InboxPanel;
	}
}
