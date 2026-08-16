import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { gatewayFetch } from "../../app/gateway-fetch.js";
import { gatewayRoute } from "../../shared/base-path.js";
import { formatCost, formatTokenCount } from "../utils/format.js";

type CostBasis = "api-billed" | "api-notional" | "subscription-notional" | "unknown";

interface CostSnapshot {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** A billed API amount only. Subscription sessions intentionally return null. */
	totalCost: number | null;
	/** Provider estimate, kept separate from billed totals and rollups. */
	notionalCostUsd?: number | null;
	costBasis?: CostBasis;
	/**
	 * Derived ratio `cacheReadTokens / (cacheReadTokens + inputTokens)`. The server
	 * derives this on every cost snapshot. Older servers may omit the field — in
	 * that case (or when the denominator is zero / value is non-finite) the UI
	 * renders an em dash, never `0%`, so cold sessions are not misread.
	 */
	cacheHitRate?: number | null;
}

interface SessionCostEntry extends CostSnapshot {
	sessionId: string;
	title: string;
	role?: string;
	delegateOf?: string;
	assistantType?: string;
	taskId?: string;
}

type CostAggregate = CostSnapshot;

/**
 * Format a cache-hit ratio for display. Returns an em dash for missing/null/
 * non-finite values so cold sessions and old-protocol servers don't show `0%`.
 */
function formatCacheHitRate(rate: number | null | undefined): string {
	if (rate === null || rate === undefined || typeof rate !== "number" || !Number.isFinite(rate)) {
		return "\u2014";
	}
	return `${Math.round(rate * 100)}%`;
}

/** Preserve small SDK estimates rather than rounding a non-zero amount to `$0`. */
function formatEstimatedApiEquivalent(cost: number): string {
	return cost < 0.1
		? `$${cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`
		: formatCost(cost);
}

function billedCost(cost: number | null | undefined): string {
	return typeof cost === "number" && Number.isFinite(cost) ? formatCost(cost) : "\u2014";
}

function subscriptionNotional(cost: CostSnapshot): number | null {
	return cost.costBasis === "subscription-notional"
		&& typeof cost.notionalCostUsd === "number"
		&& Number.isFinite(cost.notionalCostUsd)
		? cost.notionalCostUsd
		: null;
}

@customElement("cost-popover")
export class CostPopover extends LitElement {
	@property({ type: Boolean }) open = false;
	@property() sessionId?: string;
	@property() goalId?: string;
	@property() anchor: "left" | "right" = "right";

	@state() private _loading = false;
	@state() private _error = "";
	@state() private _aggregate: CostAggregate | null = null;
	@state() private _sessions: SessionCostEntry[] = [];
	@state() private _delegates: SessionCostEntry[] = [];

	override createRenderRoot() { return this; }

	override updated(changed: Map<string, unknown>) {
		if (changed.has("open") && this.open) {
			this._fetchData();
		}
	}

	private async _fetchData() {
		this._loading = true;
		this._error = "";
		try {
			if (this.goalId) {
				const res = await gatewayFetch(gatewayRoute(`/api/goals/${this.goalId}/cost/breakdown`));
				if (!res.ok) throw new Error(`${res.status}`);
				const data = await res.json();
				this._aggregate = data.aggregate;
				this._sessions = data.sessions || [];
				this._delegates = [];
			} else if (this.sessionId) {
				const res = await gatewayFetch(gatewayRoute(`/api/sessions/${this.sessionId}/cost/breakdown`));
				if (!res.ok) throw new Error(`${res.status}`);
				const data = await res.json();
				this._aggregate = data.session;
				this._delegates = data.delegates || [];
				this._sessions = [];
			}
		} catch (err) {
			this._error = "Failed to load cost data";
		} finally {
			this._loading = false;
		}
	}

	private _renderTokenRow(label: string, tokens: number, cost?: number) {
		return html`
			<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;">
				<span style="color:var(--muted-foreground)">${label}</span>
				<span style="font-variant-numeric:tabular-nums;display:flex;gap:12px;">
					<span>${formatTokenCount(tokens)}</span>
					${cost !== undefined ? html`<span style="min-width:50px;text-align:right;">${formatCost(cost)}</span>` : nothing}
				</span>
			</div>`;
	}

	private _renderSessionEntry(s: SessionCostEntry, showSubscriptionNotional = true) {
		const label = s.role
			? html`<span style="font-weight:500">${s.title}</span> <span style="opacity:0.6;font-size:11px">${s.role}</span>`
			: s.assistantType === "goal"
				? html`<span style="font-weight:500">${s.title}</span> <span style="opacity:0.6;font-size:11px">goal assistant</span>`
				: html`<span style="font-weight:500">${s.title}</span>`;
		const totalTokens = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens;
		const estimate = showSubscriptionNotional ? subscriptionNotional(s) : null;
		return html`
			<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;gap:8px;">
				<div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${label}</div>
				<div style="display:flex;gap:12px;flex-shrink:0;font-variant-numeric:tabular-nums;">
					<span style="opacity:0.6;font-size:11px;">${formatTokenCount(totalTokens)}</span>
					${estimate === null ? html`
						<span style="font-weight:500;min-width:50px;text-align:right;">${billedCost(s.totalCost)}</span>
					` : html`
						<span
							data-testid="cost-entry-subscription-notional"
							style="font-weight:500;min-width:50px;text-align:right;"
							aria-label="Estimated API-equivalent amount ${formatEstimatedApiEquivalent(estimate)}. This subscription estimate is not a billed API cost."
						>Est. ${formatEstimatedApiEquivalent(estimate)}</span>
					`}
				</div>
			</div>`;
	}

	private _renderCacheHitRow(rate: number | null | undefined) {
		return html`
			<div data-testid="cost-cache-hit" style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;">
				<span style="color:var(--muted-foreground)">Cache hit</span>
				<span style="font-variant-numeric:tabular-nums;">${formatCacheHitRate(rate)}</span>
			</div>`;
	}

	private _renderSubscriptionNotional(snapshot: CostSnapshot) {
		const estimate = subscriptionNotional(snapshot);
		if (estimate === null) return nothing;
		const amount = formatEstimatedApiEquivalent(estimate);
		return html`
			<div
				data-testid="cost-subscription-notional"
				role="note"
				aria-label="Estimated API-equivalent amount ${amount}. This is a subscription estimate, not a billed API cost, and is excluded from billed totals and goal rollups."
				style="border-bottom:1px solid var(--border);margin-bottom:8px;padding-bottom:8px;"
			>
				<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
					<span style="font-weight:600;">Estimated API equivalent</span>
					<span style="font-weight:700;font-variant-numeric:tabular-nums;">Est. ${amount}</span>
				</div>
				<div style="color:var(--muted-foreground);margin-top:3px;">Subscription estimate — not a billed API cost.</div>
			</div>`;
	}

	private _renderBreakdown(agg: CostAggregate) {
		const rows = [
			{ label: "Input tokens", tokens: agg.inputTokens },
			{ label: "Output tokens", tokens: agg.outputTokens },
		];
		if (agg.cacheReadTokens) rows.push({ label: "Cache read", tokens: agg.cacheReadTokens });
		if (agg.cacheWriteTokens) rows.push({ label: "Cache write", tokens: agg.cacheWriteTokens });
		return html`
			${rows.map(r => this._renderTokenRow(r.label, r.tokens))}
			${this._renderCacheHitRow(agg.cacheHitRate)}
		`;
	}

	override render() {
		if (!this.open) return nothing;

		const anchorStyle = this.anchor === "right"
			? "right:0;"
			: "left:0;";

		// Use top positioning (below trigger) for goal dashboard, bottom (above) for session stats bar
		const posStyle = this.goalId
			? `top:100%;margin-top:6px;`
			: `bottom:100%;margin-bottom:6px;`;

		return html`
			<div style="position:fixed;inset:0;z-index:40;" @click=${(e: Event) => { e.stopPropagation(); this.dispatchEvent(new Event("close")); }}></div>
			<div style="
				position:absolute;${posStyle}${anchorStyle}z-index:50;
				background:var(--popover);color:var(--popover-foreground);
				border:1px solid var(--border);border-radius:8px;
				padding:12px 14px;min-width:300px;max-width:400px;
				max-height:70vh;overflow-y:auto;
				box-shadow:0 4px 12px rgba(0,0,0,0.15);font-size:12px;
			">
				${this._loading ? html`<div style="text-align:center;padding:12px;color:var(--muted-foreground)">Loading…</div>` : nothing}
				${this._error ? html`<div style="color:var(--destructive)">${this._error}</div>` : nothing}
				${!this._loading && !this._error && this._aggregate ? html`
					<div style="font-weight:600;font-size:13px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
						<span>Billed API cost</span>
						<span data-testid="cost-billed-total" style="font-size:14px;font-weight:700;">${billedCost(this._aggregate.totalCost)}</span>
					</div>

					${!this.goalId ? this._renderSubscriptionNotional(this._aggregate) : nothing}

					<div style="border-bottom:1px solid var(--border);margin-bottom:8px;padding-bottom:8px;">
						${this._renderBreakdown(this._aggregate)}
					</div>

					${this._sessions.length > 0 ? html`
						<div style="font-weight:600;margin-bottom:4px;">By Agent</div>
						<div style="max-height:200px;overflow-y:auto;margin-bottom:4px;">
							${this._sessions.map(s => this._renderSessionEntry(s, !this.goalId))}
						</div>
					` : nothing}

					${this._delegates.length > 0 ? html`
						<div style="font-weight:600;margin-bottom:4px;">Delegates</div>
						<div style="max-height:200px;overflow-y:auto;margin-bottom:4px;">
							${this._delegates.map(s => this._renderSessionEntry(s))}
						</div>
					` : nothing}
				` : nothing}
			</div>
		`;
	}
}
