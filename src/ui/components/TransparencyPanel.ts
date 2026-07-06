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
	/** CLF-W3: true when a `select` decision was actually applied to live
	 *  session state (not just recorded). Omitted for `abstain` outcomes and
	 *  for any decision recorded in observe-mode. */
	applied?: boolean;
}

/**
 * Per-`decisionKind` presentation metadata (CLF-W6 transparency polish).
 *
 * `thinking` (F14 router) and `tool-approve` are left OUT of this map on
 * purpose: both already read fine as raw kind strings, and both have a real
 * apply path (`applied` can legitimately be `true`), so their existing
 * `selected: <choice>[ (applied)]` / `abstained` verdict text — pinned
 * byte-for-byte by `tests/e2e/ui/transparency-panel.spec.ts`,
 * `transparency-panel-thinking-router-enforce.spec.ts`, and
 * `transparency-panel-tool-approve-heuristic.spec.ts` — is left untouched.
 * `kindMeta()` falls back to `{ observeOnly: false }` for any kind (present
 * or future) not listed here, so an unlabeled kind always renders exactly
 * like it did before this file changed.
 *
 * The three kinds below are the "NEW" observe-only classifiers (CLF-W4/W5,
 * SWARM-W4.2) that shipped with raw, cryptic `decisionKind` strings
 * (`model-tier`, `risk`, `swarm-topology`) and — per their own file headers —
 * have NO apply/enforce mode at all this wave (model-tier-classifier.ts,
 * gate-risk-classifier.ts) or ship harness-only with zero classifiers
 * registered in production (swarm-topology-classifier.ts). `observeOnly:
 * true` drives the "observe-only" badge so a user never mistakes a recorded
 * proposal for something that changed live behavior.
 */
interface DecisionKindMeta {
	/** Human label used in the verdict line and the filter chip. Omitted (not
	 *  present in `KIND_META`) means "render exactly like before" — see the
	 *  map's own doc comment. */
	label?: string;
	/** True when this decisionKind can NEVER be `applied` (no enforce mode
	 *  exists for it at all, today) — renders the "observe-only" badge. */
	observeOnly: boolean;
	/** Human-formats a `select` decision's `choice` for the verdict line and
	 *  the detail row's `choice:` line. Defaults to `String(choice)`. */
	formatChoice?: (choice: unknown) => string;
	/** Extra Tailwind classes for a severity-accented verdict pill (gate-risk
	 *  only, today). Returns `""` for "no special accent". */
	accentClassFor?: (choice: unknown) => string;
}

function formatSwarmTopologyChoice(choice: unknown): string {
	if (!choice || typeof choice !== "object" || !("topology" in choice)) return String(choice);
	const c = choice as Record<string, unknown>;
	switch (c.topology) {
		case "solo":
			return "solo";
		case "best-of-n":
			return `best-of-n (fan-out ${String(c.fanOut)}${c.earlyKill ? ", early-kill" : ""})`;
		case "plan-fan-in":
			return `plan-fan-in (fan-out ${String(c.fanOut)})`;
		case "orchestrator-worker":
			return `orchestrator-worker (max ${String(c.maxShards)} shards)`;
		case "speculative-small-first":
			return `speculative-small-first (${String(c.cheapModel)})`;
		default:
			return String(c.topology);
	}
}

/** Severity accent for a `GateRiskLevel` choice — mirrors the amber/destructive
 *  badge idiom already used elsewhere (e.g. `SystemPromptDialog`'s
 *  "truncated"/"index" badges, `settings-page.ts`'s test-result coloring). */
function gateRiskAccentClass(choice: unknown): string {
	if (choice === "high") return "bg-destructive/15 text-destructive";
	if (choice === "medium") return "bg-amber-500/20 text-amber-600 dark:text-amber-400";
	if (choice === "low") return "bg-green-500/15 text-green-600 dark:text-green-400";
	return "";
}

const KIND_META: Record<string, DecisionKindMeta> = {
	"model-tier": { label: "Model tier", observeOnly: true },
	"risk": { label: "Gate risk", observeOnly: true, accentClassFor: gateRiskAccentClass },
	"swarm-topology": { label: "Swarm topology", observeOnly: true, formatChoice: formatSwarmTopologyChoice },
};

function kindMeta(kind: string): DecisionKindMeta {
	return KIND_META[kind] ?? { observeOnly: false };
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
 * rationale/ms/applied. Modeled on `SystemPromptDialog`'s disclosure idiom
 * for visual consistency with the rest of the app's folded-detail
 * components.
 *
 * CLF-W6 — when a turn accumulates decisions of more than one `decisionKind`
 * (increasingly common now that model-tier/gate-risk/swarm-topology all
 * dispatch alongside the original thinking/tool-approve seams), a lightweight
 * kind-filter chip row appears above the rows so a user can isolate one kind
 * without scrolling past the rest. Hidden entirely for the single-kind case —
 * same "no chrome when there's nothing to filter" discipline as the panel's
 * own zero-decisions empty state.
 */
@customElement("transparency-panel")
export class TransparencyPanel extends LitElement {
	@property({ type: Array }) decisions: TransparencyDecision[] = [];

	@state() private _expanded = false;
	@state() private _expandedRows = new Set<number>();
	/** `null` = show every kind (default, and the only state possible when
	 *  the turn has a single kind). */
	@state() private _kindFilter: string | null = null;

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
		const detailId = `transparency-panel-row-detail-${index}`;
		const meta = kindMeta(d.decisionKind);
		const verdict = d.decision.kind === "select"
			? meta.label
				? `${meta.label} proposed: ${meta.formatChoice ? meta.formatChoice(d.decision.choice) : String(d.decision.choice)}`
				: `selected: ${String(d.decision.choice)}${d.applied ? " (applied)" : ""}`
			: "abstained";
		const accentClass = d.decision.kind === "select" && meta.accentClassFor ? meta.accentClassFor(d.decision.choice) : "";
		return html`
			<div class="border border-border rounded-md overflow-hidden text-xs" data-testid="transparency-panel-row">
				<button
					type="button"
					class="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-secondary/50 transition-colors"
					data-testid="transparency-panel-row-toggle"
					aria-expanded=${expanded ? "true" : "false"}
					aria-controls=${detailId}
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
					<span
						class="px-1 py-0.5 rounded bg-secondary text-muted-foreground shrink-0"
						title=${meta.label ?? d.decisionKind}
						data-testid="transparency-panel-row-kind"
					>${d.decisionKind}</span>
					${meta.observeOnly
						? html`<span
								class="text-[10px] px-1 py-0.5 rounded border border-border text-muted-foreground shrink-0 uppercase tracking-wide"
								data-testid="transparency-panel-row-observe-only"
								title="Recorded for telemetry only — this decision kind has no apply/enforce path; it never changes live behavior."
							>observe-only</span>`
						: nothing}
					<span
						class="flex-1 truncate ${accentClass ? `px-1 py-0.5 rounded ${accentClass}` : ""}"
						data-testid="transparency-panel-row-verdict"
					>${verdict}</span>
					<span class="text-muted-foreground shrink-0">consulted ${d.consulted.length}</span>
					<span class="text-muted-foreground shrink-0 tabular-nums">${d.ms}ms</span>
				</button>
				${expanded
					? html`
							<div id=${detailId} class="border-t border-border px-2 py-1.5 space-y-1 bg-muted/40">
								<div>
									<span class="text-muted-foreground">consulted:</span>
									${d.consulted.length ? d.consulted.join(", ") : "(none)"}
								</div>
								${d.decision.kind === "select"
									? html`
											<div>
												<span class="text-muted-foreground">choice:</span>
												${meta.formatChoice ? meta.formatChoice(d.decision.choice) : JSON.stringify(d.decision.choice)}
											</div>
											${d.decision.confidence !== undefined
												? html`<div><span class="text-muted-foreground">confidence:</span> ${d.decision.confidence}</div>`
												: nothing}
											${d.decision.rationale
												? html`<div><span class="text-muted-foreground">rationale:</span> ${d.decision.rationale}</div>`
												: nothing}
											<div><span class="text-muted-foreground">applied:</span> ${d.applied ? "yes" : "no"}</div>
										`
									: nothing}
								<div><span class="text-muted-foreground">ms:</span> ${d.ms}</div>
							</div>
						`
					: nothing}
			</div>
		`;
	}

	override render() {
		if (!this.decisions || this.decisions.length === 0) return nothing;
		const bodyId = "transparency-panel-body";
		// Stable kind order: first-seen order across the turn's decisions,
		// rather than alphabetical — keeps chip order matching row order.
		const kinds: string[] = [];
		for (const d of this.decisions) {
			if (!kinds.includes(d.decisionKind)) kinds.push(d.decisionKind);
		}
		// Guard against a stale filter (e.g. `decisions` swapped to a new turn
		// whose kinds don't include the previously-selected one) without
		// mutating state mid-render — falls back to "show all" for THIS render
		// only; a subsequent user click still sets `_kindFilter` normally.
		const effectiveFilter = this._kindFilter !== null && kinds.includes(this._kindFilter) ? this._kindFilter : null;
		const visibleDecisions = this.decisions
			.map((d, i) => ({ d, i }))
			.filter(({ d }) => effectiveFilter === null || d.decisionKind === effectiveFilter);
		return html`
			<div class="mt-2 text-xs" data-testid="transparency-panel">
				<button
					type="button"
					class="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
					data-testid="transparency-panel-toggle"
					aria-expanded=${this._expanded ? "true" : "false"}
					aria-controls=${bodyId}
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
					? html`<div id=${bodyId} class="mt-1.5 space-y-1.5">
							${kinds.length > 1
								? html`
										<div
											class="inline-flex flex-wrap rounded-md border border-border overflow-hidden"
											role="group"
											data-testid="transparency-panel-kind-filter"
										>
											<button
												type="button"
												data-testid="transparency-panel-kind-filter-all"
												aria-pressed=${effectiveFilter === null ? "true" : "false"}
												class="text-[11px] px-2 py-1 transition-colors ${effectiveFilter === null
													? "bg-primary text-primary-foreground font-medium"
													: "bg-background text-muted-foreground hover:text-foreground hover:bg-secondary"}"
												@click=${() => {
													this._kindFilter = null;
												}}
											>all (${this.decisions.length})</button>
											${kinds.map((kind) => {
												const count = this.decisions.filter((d) => d.decisionKind === kind).length;
												const label = kindMeta(kind).label ?? kind;
												const active = effectiveFilter === kind;
												return html`<button
													type="button"
													data-testid="transparency-panel-kind-filter-${kind}"
													aria-pressed=${active ? "true" : "false"}
													class="text-[11px] px-2 py-1 border-l border-border transition-colors ${active
														? "bg-primary text-primary-foreground font-medium"
														: "bg-background text-muted-foreground hover:text-foreground hover:bg-secondary"}"
													@click=${() => {
														this._kindFilter = active ? null : kind;
													}}
												>${label} (${count})</button>`;
											})}
										</div>
									`
								: nothing}
							<div class="space-y-1" data-testid="transparency-panel-rows">
								${visibleDecisions.map(({ d, i }) => this.renderRow(d, i))}
							</div>
						</div>`
					: nothing}
			</div>
		`;
	}
}
