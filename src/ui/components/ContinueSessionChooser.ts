/**
 * <continue-session-chooser> — Confirm-only modal shown when the user clicks
 * "Continue in New Session" on an archived session. Lossless continue means
 * there's no seed-mode choice (the new session rehydrates from a clone of
 * the source `.jsonl`), so this component is a simple Cancel/Continue dialog.
 *
 * Light DOM so inherited CSS (Tailwind-like utility classes + CSS vars)
 * applies. The modal manages its own backdrop + Escape-to-close behaviour.
 */
import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("continue-session-chooser")
export class ContinueSessionChooser extends LitElement {
	/** The archived session being continued. Used for display only. */
	@property() sessionId = "";
	/** Rough message count shown in the modal chrome. */
	@property({ type: Number }) messageCount = 0;
	/**
	 * Proposal types found in the archived session's `proposal-drafts/<id>/`
	 * directory. When non-empty the modal appends a one-liner explaining that
	 * the draft will be carried over into the new session.
	 */
	@property({ type: Array }) proposalTypes: string[] = [];

	private _boundKeyDown = this._onKeyDown.bind(this);

	override createRenderRoot() {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		// The custom element must have non-zero layout for Playwright's
		// visibility heuristic (zero-size elements are treated as hidden).
		this.style.position = "fixed";
		this.style.inset = "0";
		this.style.zIndex = "50";
		document.addEventListener("keydown", this._boundKeyDown);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("keydown", this._boundKeyDown);
	}

	private _onKeyDown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			this._cancel();
		}
	}

	private _cancel = () => {
		this.dispatchEvent(new CustomEvent("cancel", { bubbles: false }));
	};

	private _confirm = () => {
		this.dispatchEvent(new CustomEvent("continue", { bubbles: false }));
	};

	override render() {
		return html`
			<div
				class="fixed inset-0 z-50 flex items-center justify-center p-4"
				style="background: rgba(0,0,0,0.55);"
				data-continue-chooser-backdrop
				@click=${(e: MouseEvent) => {
					if (e.target === e.currentTarget) this._cancel();
				}}
			>
				<div
					role="dialog"
					aria-modal="true"
					aria-label="Continue in new session"
					class="bg-background text-foreground rounded-lg shadow-xl w-full"
					style="max-width: 460px; border:1px solid var(--border);"
				>
					<div class="flex flex-col gap-3 p-5">
						<div class="flex flex-col gap-1">
							<h2 class="text-base font-semibold">Continue in new session</h2>
							<p class="text-xs text-muted-foreground">
								Start a fresh session configured like this one. The full
								history will be cloned losslessly — the agent picks up where
								you left off.
							</p>
							${this.proposalTypes.length > 0 ? html`
								<p class="text-xs text-muted-foreground" data-proposal-carryover>
									Your ${this.proposalTypes.join(" / ")} proposal draft will be carried over so you can keep editing.
								</p>
							` : null}
						</div>

						<div class="flex items-center justify-end gap-2 pt-1">
							<button
								type="button"
								class="px-3 py-1.5 text-sm rounded-md border hover:bg-muted"
								style="border-color: var(--border);"
								data-action="cancel"
								@click=${this._cancel}
							>
								Cancel
							</button>
							<button
								type="button"
								class="px-3 py-1.5 text-sm rounded-md text-white"
								style="background: var(--primary, #3b82f6); border:1px solid var(--primary, #3b82f6);"
								data-action="continue"
								@click=${this._confirm}
							>
								Continue
							</button>
						</div>
					</div>
				</div>
			</div>
		`;
	}
}

if (!customElements.get("continue-session-chooser")) {
	customElements.define("continue-session-chooser", ContinueSessionChooser);
}
