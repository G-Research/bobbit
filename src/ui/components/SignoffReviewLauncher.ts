import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { FileText, Loader2 } from "lucide";
import {
	launchSignoffReview,
	type SignoffReviewEventDetail,
	type SignoffReviewTarget,
} from "../../app/signoff-review-launch.js";
import {
	GATE_STATUS_CLIENT_EVENT,
	HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE,
} from "../../app/gate-status-events.js";

export const SIGNOFF_REVIEW_LAUNCHED_EVENT = "signoff-review-launched";

function targetKey(target: SignoffReviewTarget | undefined): string {
	return target ? `${target.goalId}::${target.gateId}::${target.signalId}::${target.stepName}` : "";
}

/** Compact, light-DOM launcher shared by every pending human sign-off surface. */
@customElement("signoff-review-launcher")
export class SignoffReviewLauncher extends LitElement {
	@property({ attribute: false }) target?: SignoffReviewTarget;
	@property({ attribute: "button-class" }) buttonClass = "";
	@property({ attribute: "button-testid" }) buttonTestId = "signoff-review-launcher";
	@property({ attribute: "error-testid" }) errorTestId = "signoff-review-launcher-error";

	@state() private _loading = false;
	@state() private _error = false;
	@state() private _resolved = false;

	private _targetKey = "";

	private _onGateStatusEvent = (event: Event) => {
		const detail = (event as CustomEvent).detail;
		const target = this.target;
		if (!target || !detail || typeof detail !== "object") return;
		if (detail.goalId !== target.goalId || detail.gateId !== target.gateId || detail.signalId !== target.signalId) return;

		const completesTarget = (detail.type === "gate_verification_step_complete"
			|| detail.type === HUMAN_SIGNOFF_RESOLVED_EVENT_TYPE)
			&& detail.stepName === target.stepName;
		const completesVerification = detail.type === "gate_verification_complete";
		if (!completesTarget && !completesVerification) return;

		this._resolved = true;
		this._loading = false;
		this._error = false;
	};

	createRenderRoot() {
		return this;
	}

	connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener(GATE_STATUS_CLIENT_EVENT, this._onGateStatusEvent);
		document.addEventListener("gate-verification-event", this._onGateStatusEvent);
		this._ensureStyles();
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener(GATE_STATUS_CLIENT_EVENT, this._onGateStatusEvent);
		document.removeEventListener("gate-verification-event", this._onGateStatusEvent);
	}

	protected willUpdate(): void {
		const nextKey = targetKey(this.target);
		if (nextKey !== this._targetKey) {
			this._targetKey = nextKey;
			this._loading = false;
			this._error = false;
			this._resolved = false;
		}
	}

	private async _launch(event: MouseEvent): Promise<void> {
		event.stopPropagation();
		if (!this.target || this._loading || this._resolved) return;
		this._loading = true;
		this._error = false;
		try {
			const detail = await launchSignoffReview(this.target);
			this.dispatchEvent(new CustomEvent<SignoffReviewEventDetail>(SIGNOFF_REVIEW_LAUNCHED_EVENT, {
				detail,
				bubbles: true,
				composed: true,
			}));
		} catch {
			this._error = true;
		} finally {
			this._loading = false;
		}
	}

	render() {
		if (!this.target || this._resolved) return nothing;
		const label = this.target.stepLabel || this.target.stepName;
		return html`
			<button
				type="button"
				class=${`signoff-review-button ${this.buttonClass}`.trim()}
				?disabled=${this._loading}
				aria-busy=${this._loading ? "true" : "false"}
				aria-label=${`Start review: ${label}`}
				@click=${this._launch}
				data-testid=${this.buttonTestId}
			>
				${this._loading ? icon(Loader2, "xs", "animate-spin") : icon(FileText, "xs")}
				<span>${this._loading ? "Opening…" : "Start Review"}</span>
			</button>
			${this._error ? html`
				<div class="signoff-review-error" role="alert" data-testid=${this.errorTestId}>Couldn’t open review. Try again.</div>
			` : nothing}
		`;
	}

	private _ensureStyles(): void {
		if (typeof document === "undefined" || document.getElementById("signoff-review-launcher-styles")) return;
		const style = document.createElement("style");
		style.id = "signoff-review-launcher-styles";
		style.textContent = `
			signoff-review-launcher {
				display: inline-flex;
				flex-direction: column;
				align-items: flex-end;
				gap: 3px;
			}
			.signoff-review-button {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				gap: 3px;
				height: 22px;
				min-height: 22px;
				box-sizing: border-box;
				padding: 1px 7px;
				border-radius: 4px;
				border: 1px solid var(--border);
				background: transparent;
				color: var(--muted-foreground);
				cursor: pointer;
				font-family: inherit;
				font-size: 12px;
				font-weight: 500;
				line-height: 1;
				white-space: nowrap;
				transition: background 150ms, border-color 150ms, color 150ms, opacity 150ms;
			}
			.signoff-review-button:hover:not(:disabled) {
				background: var(--accent, var(--secondary));
				color: var(--foreground);
			}
			.signoff-review-button:focus-visible {
				outline: 2px solid var(--primary);
				outline-offset: 2px;
			}
			.signoff-review-button:disabled {
				cursor: wait;
				opacity: 0.65;
			}
			.signoff-review-button svg {
				width: 12px;
				height: 12px;
				flex-shrink: 0;
			}
			.signoff-review-error {
				max-width: 210px;
				font-size: 11px;
				line-height: 1.25;
				color: var(--negative, var(--destructive, var(--foreground)));
			}
		`;
		document.head.appendChild(style);
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"signoff-review-launcher": SignoffReviewLauncher;
	}
}
