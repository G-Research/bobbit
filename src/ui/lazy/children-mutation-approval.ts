/**
 * <children-mutation-approval> — in-chat Approve / Reject buttons for a
 * `goal_plan_propose` tool result that landed in the approval queue.
 *
 * Posts to POST /api/goals/:goalId/mutation/:requestId/decision (same shape
 * as src/app/custom-messages.ts:80 — the dashboard mutation-pending card).
 *
 * A module-level WeakRef-equivalent map keyed by requestId stores the user's
 * decision so re-mounts (caused by WS `mutation_decided` outer re-render) do
 * not snap back to the idle state.
 */
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { gatewayFetch } from "../../app/gateway-fetch.js";

type DecisionState = "idle" | "posting-approve" | "posting-reject" | "approved" | "rejected" | "error";

// Module-level decision memory keyed by requestId.
const decisionMemory = new Map<string, "approved" | "rejected">();

@customElement("children-mutation-approval")
export class ChildrenMutationApproval extends LitElement {
	static override styles = css`
		:host { display: block; }
		.row { display: flex; gap: 8px; align-items: center; }
		button {
			padding: 4px 10px;
			border-radius: 6px;
			border: 1px solid var(--border);
			background: transparent;
			color: var(--foreground);
			cursor: pointer;
			font-size: 12px;
			font-family: inherit;
		}
		button.approve {
			border-color: var(--primary);
			background: var(--primary);
			color: var(--primary-foreground);
		}
		button[disabled] {
			opacity: 0.6;
			cursor: default;
		}
		.pill {
			padding: 2px 8px;
			border-radius: 6px;
			font-size: 12px;
			font-weight: 600;
		}
		.pill.approved { background: rgba(34, 197, 94, 0.15); color: rgb(22, 163, 74); }
		.pill.rejected { background: rgba(239, 68, 68, 0.15); color: rgb(220, 38, 38); }
		.error { color: var(--destructive, #c00); font-size: 12px; }
	`;

	@property({ attribute: "request-id" }) requestId: string = "";
	@property({ attribute: "goal-id" }) goalId: string = "";

	@state() private _state: DecisionState = "idle";
	@state() private _errorMessage = "";

	override connectedCallback(): void {
		super.connectedCallback();
		const remembered = this.requestId ? decisionMemory.get(this.requestId) : undefined;
		if (remembered) this._state = remembered;
	}

	private async _decide(decision: "approve" | "reject"): Promise<void> {
		if (!this.requestId || !this.goalId) {
			this._state = "error";
			this._errorMessage = "Missing goalId or requestId";
			return;
		}
		this._state = decision === "approve" ? "posting-approve" : "posting-reject";
		this._errorMessage = "";
		try {
			const resp = await gatewayFetch(`/api/goals/${this.goalId}/mutation/${this.requestId}/decision`, {
				method: "POST",
				body: JSON.stringify({ decision }),
			});
			if (!resp.ok) {
				let body = "";
				try { body = await resp.text(); } catch { /* ignore */ }
				this._state = "error";
				this._errorMessage = `HTTP ${resp.status}${body ? ` — ${body.slice(0, 120)}` : ""}`;
				return;
			}
			const next: "approved" | "rejected" = decision === "approve" ? "approved" : "rejected";
			this._state = next;
			decisionMemory.set(this.requestId, next);
		} catch (err: any) {
			this._state = "error";
			this._errorMessage = err?.message ? String(err.message) : "Network error";
		}
	}

	override render() {
		const s = this._state;
		if (s === "approved") return html`<span class="pill approved" data-testid="children-mutation-decided">Approved ✓</span>`;
		if (s === "rejected") return html`<span class="pill rejected" data-testid="children-mutation-decided">Rejected ✗</span>`;
		const posting = s === "posting-approve" || s === "posting-reject";
		return html`
			<div class="row">
				<button
					class="approve"
					data-testid="children-mutation-approve"
					?disabled=${posting}
					@click=${() => this._decide("approve")}
				>${s === "posting-approve" ? "Approving…" : "Approve"}</button>
				<button
					data-testid="children-mutation-reject"
					?disabled=${posting}
					@click=${() => this._decide("reject")}
				>${s === "posting-reject" ? "Rejecting…" : "Reject"}</button>
				${s === "error"
					? html`<span class="error" data-testid="children-mutation-error">Failed — ${this._errorMessage || "retry"}</span>`
					: ""}
			</div>
		`;
	}
}
