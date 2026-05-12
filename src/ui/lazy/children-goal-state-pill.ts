/**
 * <children-goal-state-pill> — live goal-state pill keyed by goalId.
 *
 * Subscribes to subscribeGoalStateChanges() (defined in remote-agent.ts) and
 * re-fetches goal state via gatewayFetch('/api/goals/:id') when notified.
 */
import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { gatewayFetch } from "../../app/gateway-fetch.js";

@customElement("children-goal-state-pill")
export class ChildrenGoalStatePill extends LitElement {
	static override styles = css`
		:host { display: inline-block; }
		.pill {
			padding: 2px 8px;
			border-radius: 6px;
			font-size: 11px;
			font-weight: 500;
		}
		.pending, .archived, .shelved { background: var(--muted); color: var(--muted-foreground); }
		.archived { text-decoration: line-through; }
		.in-progress { background: rgba(59, 130, 246, 0.15); color: rgb(37, 99, 235); }
		.complete { background: rgba(34, 197, 94, 0.15); color: rgb(22, 163, 74); }
		.failed { background: rgba(239, 68, 68, 0.15); color: rgb(220, 38, 38); }
	`;

	@property({ attribute: "goal-id" }) goalId: string = "";
	@property({ attribute: "initial-state" }) initialState: string = "";

	@state() private _state: string = "";

	private _unsubscribe: (() => void) | null = null;

	override connectedCallback(): void {
		super.connectedCallback();
		this._state = this.initialState || "";
		// Lazy import to keep the bundle small and avoid eager remote-agent load
		// in test fixtures that don't wire one up.
		void this._subscribe();
		void this._refetch();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		if (this._unsubscribe) {
			this._unsubscribe();
			this._unsubscribe = null;
		}
	}

	private async _subscribe(): Promise<void> {
		try {
			const mod = await import("../../app/remote-agent.js");
			const sub = (mod as any).subscribeGoalStateChanges;
			if (typeof sub === "function") {
				this._unsubscribe = sub((evt: { goalId?: string } | undefined) => {
					if (!evt || !evt.goalId || evt.goalId === this.goalId) {
						void this._refetch();
					}
				});
			}
		} catch { /* fixture environments may not have remote-agent */ }
	}

	private async _refetch(): Promise<void> {
		if (!this.goalId) return;
		try {
			const resp = await gatewayFetch(`/api/goals/${this.goalId}`);
			if (!resp.ok) return;
			const body = await resp.json().catch(() => null);
			const goal = body?.goal || body;
			const next = goal?.archived ? "archived" : goal?.state;
			if (typeof next === "string" && next) this._state = next;
		} catch { /* non-fatal */ }
	}

	override render() {
		const s = this._state || "pending";
		return html`<span class="pill ${s}" data-testid="children-goal-state-pill" data-state="${s}">${s}</span>`;
	}
}
