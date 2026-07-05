import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

/**
 * Mirrors `DecisionOutcome` (`src/server/agent/decision-types.ts`) 1:1.
 * Duplicated client-side rather than imported — the UI bundle never imports
 * server modules (same precedent as `PromptSection` in `SystemPromptDialog.ts`,
 * which redeclares the server's `PromptSection` shape locally). Keep these two
 * shapes in sync by hand if the server type changes.
 */
export interface TransparencyDecision {
	ts: number;
	point: string;
	decisionKind: string;
	consulted: string[];
	decision:
		| { kind: "select"; choice: unknown; confidence?: number; rationale?: string }
		| { kind: "abstain" };
	ms: number;
}

/**
 * CLF-W1a — Transparency Panel (decisions rows only; per-turn injected
 * context blocks are a separate, deferred item — see the Fable program's
 * transparency-panel design note).
 *
 * Renders NOTHING when there are zero decisions for the turn — no layout
 * shift, no DOM, byte-identical to before this component existed (pinned by
 * `tests/e2e/ui/transparency-panel.spec.ts`'s empty-turn case). Folded by
 * default; expanding reveals one row per `DecisionOutcome`, itself
 * expandable for consulted-classifier ids and the select choice/confidence/
 * rationale. Modeled on `SystemPromptDialog`'s disclosure idiom for visual
 * consistency with the rest of the app's folded-detail components.
 */
@customElement("transparency-panel")
export class TransparencyPanel extends LitElement {
	@property({ type: Array }) decisions: TransparencyDecision[] = [];

	@state() private _expanded = false;
	@state() private _expandedRows = new Set<number>();

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private toggleRow(index: number): void {
		const next = new Set(this._expandedRows);
		if (next.has(index)) next.delete(index);
		else next.add(index);
		this._expandedRows = next;
	}

	private renderRow(d: TransparencyDecision, index: number) {
		const expanded = this._expandedRows.has(index);
		const verdict = d.decision.kind === "select" ? `selected: ${String(d.decision.choice)}` : "abstained";
		return html`
			<div class="border border-border rounded-md overflow-hidden text-xs" data-testid="transparency-panel-row">
				<button
					type="button"
					class="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-secondary/50 transition-colors"
					data-testid="transparency-panel-row-toggle"
					@click=${() => this.toggleRow(index)}
				>
					<svg
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						class="shrink-0 transition-transform ${expanded ? "rotate-90" : ""}"
					>
						<path d="m9 18 6-6-6-6"></path>
					</svg>
					<span class="font-mono text-muted-foreground truncate">${d.point}</span>
					<span class="px-1 py-0.5 rounded bg-secondary text-muted-foreground shrink-0">${d.decisionKind}</span>
					<span class="flex-1 truncate">${verdict}</span>
					<span class="text-muted-foreground shrink-0">consulted ${d.consulted.length}</span>
					<span class="text-muted-foreground shrink-0 tabular-nums">${d.ms}ms</span>
				</button>
				${expanded
					? html`
							<div class="border-t border-border px-2 py-1.5 space-y-1 bg-muted/40">
								<div>
									<span class="text-muted-foreground">consulted:</span>
									${d.consulted.length ? d.consulted.join(", ") : "(none)"}
								</div>
								${d.decision.kind === "select"
									? html`
											<div><span class="text-muted-foreground">choice:</span> ${JSON.stringify(d.decision.choice)}</div>
											${d.decision.confidence !== undefined
												? html`<div><span class="text-muted-foreground">confidence:</span> ${d.decision.confidence}</div>`
												: nothing}
											${d.decision.rationale
												? html`<div><span class="text-muted-foreground">rationale:</span> ${d.decision.rationale}</div>`
												: nothing}
										`
									: nothing}
							</div>
						`
					: nothing}
			</div>
		`;
	}

	override render() {
		if (!this.decisions || this.decisions.length === 0) return nothing;
		return html`
			<div class="mt-2 text-xs" data-testid="transparency-panel">
				<button
					type="button"
					class="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
					data-testid="transparency-panel-toggle"
					@click=${() => {
						this._expanded = !this._expanded;
					}}
				>
					<svg
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						class="shrink-0 transition-transform ${this._expanded ? "rotate-90" : ""}"
					>
						<path d="m9 18 6-6-6-6"></path>
					</svg>
					<span>${this.decisions.length} decision${this.decisions.length === 1 ? "" : "s"}</span>
				</button>
				${this._expanded
					? html`<div class="mt-1.5 space-y-1" data-testid="transparency-panel-rows">
							${this.decisions.map((d, i) => this.renderRow(d, i))}
						</div>`
					: nothing}
			</div>
		`;
	}
}
