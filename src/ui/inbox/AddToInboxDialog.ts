import { html, LitElement, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

/**
 * <add-to-inbox-dialog> — modal composer for manually enqueuing an
 * inbox entry against the active staff agent.
 *
 * POSTs `/api/staff/:id/inbox` with `{ title, prompt, source: { type: "manual_ui" } }`.
 * On success, closes itself; the new entry arrives via the WS handler in
 * `inbox-panel.ts` and is rendered into the Pending section.
 *
 * Light DOM. Uses the same design tokens as the rest of the app.
 */
@customElement("add-to-inbox-dialog")
export class AddToInboxDialog extends LitElement {
	@property({ type: String })
	staffId = "";

	@state() private _title = "";
	@state() private _prompt = "";
	@state() private _submitting = false;
	@state() private _error: string | null = null;

	static styles = css`
		:host {
			position: fixed;
			inset: 0;
			z-index: 100;
		}
	`;

	createRenderRoot() {
		return this;
	}

	connectedCallback(): void {
		super.connectedCallback();
		// Light DOM means `static styles` doesn't apply to the host. Set the
		// host-level layout inline so Playwright's toBeVisible() finds the
		// element and so the backdrop fills the viewport via the host box.
		this.style.position = "fixed";
		this.style.inset = "0";
		this.style.zIndex = "100";
		this.style.display = "block";
	}

	private _close(): void {
		this.dispatchEvent(new CustomEvent("inbox-add-close", { bubbles: true, composed: true }));
	}

	private async _submit(): Promise<void> {
		if (this._submitting) return;
		const title = this._title.trim();
		const prompt = this._prompt.trim();
		if (!title || !prompt) {
			this._error = "Title and prompt are required.";
			return;
		}
		this._submitting = true;
		this._error = null;
		try {
			const res = await fetch(`/api/staff/${encodeURIComponent(this.staffId)}/inbox`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title,
					prompt,
					source: { type: "manual_ui" },
				}),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				this._error = `Failed (${res.status}): ${text || "unknown"}`;
				this._submitting = false;
				return;
			}
			this.dispatchEvent(new CustomEvent("inbox-add-submitted", {
				bubbles: true,
				composed: true,
			}));
			this._close();
		} catch (err) {
			this._error = (err as Error)?.message || String(err);
			this._submitting = false;
		}
	}

	render() {
		return html`
			<div
				class="add-to-inbox-backdrop"
				@click=${this._close}
				style="position:fixed;inset:0;background:color-mix(in oklch, var(--background) 50%, transparent);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:100;"
			>
				<div
					class="add-to-inbox-dialog"
					role="dialog"
					aria-label="Add to inbox"
					@click=${(e: Event) => e.stopPropagation()}
					style="background:var(--card,var(--background));color:var(--foreground);border:1px solid var(--border);border-radius:8px;padding:18px;width:min(520px, 90vw);box-shadow:0 8px 24px color-mix(in oklch, var(--foreground) 12%, transparent);display:flex;flex-direction:column;gap:12px;"
				>
					<div style="display:flex;align-items:center;justify-content:space-between;">
						<h2 style="margin:0;font-size:14px;font-weight:600;">Add to inbox</h2>
						<button
							@click=${this._close}
							style="background:none;border:none;color:var(--muted-foreground);font-size:18px;cursor:pointer;line-height:1;padding:0 4px;"
							title="Close"
							aria-label="Close"
						>×</button>
					</div>
					<div>
						<label style="display:block;font-size:11px;color:var(--muted-foreground);margin-bottom:4px;">Title</label>
						<input
							class="add-to-inbox-title"
							type="text"
							.value=${this._title}
							@input=${(e: Event) => { this._title = (e.target as HTMLInputElement).value; }}
							placeholder="e.g. Investigate slow queries"
							style="width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--background);color:var(--foreground);font-size:13px;"
						/>
					</div>
					<div>
						<label style="display:block;font-size:11px;color:var(--muted-foreground);margin-bottom:4px;">Prompt</label>
						<textarea
							class="add-to-inbox-prompt"
							rows="6"
							.value=${this._prompt}
							@input=${(e: Event) => { this._prompt = (e.target as HTMLTextAreaElement).value; }}
							placeholder="What should the agent do?"
							style="width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--background);color:var(--foreground);font-size:13px;font-family:inherit;resize:vertical;min-height:120px;"
						></textarea>
					</div>
					${this._error
						? html`<div style="font-size:12px;color:var(--negative,var(--destructive));">${this._error}</div>`
						: ""}
					<div style="display:flex;justify-content:flex-end;gap:8px;padding-top:4px;">
						<button
							@click=${this._close}
							?disabled=${this._submitting}
							style="font-size:12px;padding:6px 12px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--foreground);cursor:pointer;"
						>Cancel</button>
						<button
							class="add-to-inbox-submit"
							@click=${this._submit}
							?disabled=${this._submitting || !this._title.trim() || !this._prompt.trim()}
							style="font-size:12px;padding:6px 14px;border-radius:4px;border:1px solid var(--primary);background:var(--primary);color:var(--primary-foreground,white);cursor:pointer;"
						>${this._submitting ? "Adding…" : "Add to inbox"}</button>
					</div>
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"add-to-inbox-dialog": AddToInboxDialog;
	}
}
