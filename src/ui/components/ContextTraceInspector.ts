import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ContextInspectorItem, ContextTraceState, SafePromptExtensionAudit, SafeTraceOutcomeRow, SafeTraceProviderRow } from "../../app/context-trace.js";

// The controller owns the only Context trace state contract. Keep this re-export
// for callers that consume the component as an isolated custom element.
export type { ContextTraceState } from "../../app/context-trace.js";

const EMPTY_STATE: ContextTraceState = {
	status: "idle",
	items: [],
	limit: 100,
	hasEarlier: false,
	isRefreshing: false,
	refreshError: false,
};

const OUTCOME_KIND_LABELS: Record<SafeTraceOutcomeRow["kind"], string> = {
	decision: "Decision",
	advisory: "Advisory",
	audit: "Audit",
};
const OUTCOME_LABELS: Record<SafeTraceOutcomeRow["outcome"], string> = {
	advised: "Advised",
	applied: "Applied",
	denied: "Denied",
	dropped: "Dropped",
	error: "Error",
	superseded: "Superseded",
};
const CAPABILITY_STAGE_LABELS = {
	skills: "Skill selection",
	mcp: "MCP selection",
} as const;
const SELECTION_FINGERPRINT = /^(?:[a-f0-9]{64}|[a-z2-7]{52})$/;
const MAX_DISPLAY_NUMBER = 1_000_000_000;

function safeDisplayNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(MAX_DISPLAY_NUMBER, Math.trunc(value))
		: undefined;
}

function localizedTime(timestamp: number): string {
	if (!Number.isFinite(timestamp)) return "Unknown time";
	try {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "medium",
		}).format(new Date(timestamp));
	} catch {
		return "Unknown time";
	}
}

function machineTime(timestamp: number): string {
	if (!Number.isFinite(timestamp)) return "";
	try { return new Date(timestamp).toISOString(); }
	catch { return ""; }
}

/**
 * Read-only projection of the normalized context trace controller state.
 * Raw API records never reach this element: it accepts only its allow-listed,
 * display-safe input types and interpolates every value as text.
 */
@customElement("context-trace-inspector")
export class ContextTraceInspector extends LitElement {
	@property({ attribute: false }) state: ContextTraceState = EMPTY_STATE;

	createRenderRoot() {
		return this;
	}

	override firstUpdated(): void {
		// A newly opened non-modal panel should enter at its heading; subsequent
		// refreshes deliberately preserve the user's current control focus.
		queueMicrotask(() => this.querySelector<HTMLElement>("[data-context-trace-heading]")?.focus());
	}

	private emit(name: "context-trace-retry" | "context-trace-refresh" | "context-trace-load-earlier"): void {
		this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
	}

	private renderProvider(provider: SafeTraceProviderRow) {
		return html`
			<li class="context-trace-provider" data-testid="context-trace-provider">
				<div class="context-trace-provider__name">${provider.id}</div>
				<dl class="context-trace-provider__metrics">
					<div><dt>Latency</dt> <dd>${provider.latencyMs} ms</dd></div>
					<div><dt>Kept</dt> <dd>${provider.keptBlocks}</dd></div>
					<div><dt>Omitted</dt> <dd>${provider.omittedBlocks}</dd></div>
				</dl>
				${provider.error ? html`<span class="context-trace-provider__status">${provider.error}</span>` : nothing}
			</li>
		`;
	}

	private renderAudit(audit: SafePromptExtensionAudit) {
		const usage = audit.usage;
		return html`
			<section class="context-trace-audit" data-testid="prompt-extension-audit">
				<h5>Prompt extension authoring</h5>
				<dl class="context-trace-outcome__details">
					<div><dt>Status</dt><dd>${audit.status}</dd></div>
					<div><dt>Section</dt><dd>${audit.packId}/${audit.sectionId}</dd></div>
					<div><dt>Actor</dt><dd>${audit.actor}</dd></div>
					<div><dt>Trigger</dt><dd>${audit.trigger}</dd></div>
					${audit.model ? html`<div><dt>Model</dt><dd>${audit.model}</dd></div>` : nothing}
					${audit.thinkingLevel ? html`<div><dt>Thinking</dt><dd>${audit.thinkingLevel}</dd></div>` : nothing}
					${audit.durationMs !== undefined ? html`<div><dt>Duration</dt><dd>${audit.durationMs} ms</dd></div>` : nothing}
					${audit.sectionBytes !== undefined ? html`<div><dt>Section bytes</dt><dd>${audit.sectionBytes}${audit.sectionShare !== undefined ? ` (${(audit.sectionShare * 100).toFixed(1)}%)` : ""}</dd></div>` : nothing}
					${audit.totalPromptBytes !== undefined ? html`<div><dt>Prompt bytes</dt><dd>${audit.totalPromptBytes}</dd></div>` : nothing}
					${usage?.inputTokens !== undefined ? html`<div><dt>Input tokens</dt><dd>${usage.inputTokens}</dd></div>` : nothing}
					${usage?.outputTokens !== undefined ? html`<div><dt>Output tokens</dt><dd>${usage.outputTokens}</dd></div>` : nothing}
					${usage?.cacheReadTokens !== undefined ? html`<div><dt>Cache read</dt><dd>${usage.cacheReadTokens}</dd></div>` : nothing}
					${usage?.cacheWriteTokens !== undefined ? html`<div><dt>Cache write</dt><dd>${usage.cacheWriteTokens}</dd></div>` : nothing}
					${usage?.cost !== undefined ? html`<div><dt>Cost</dt><dd>${usage.cost}</dd></div>` : nothing}
				</dl>
				${audit.diff ? html`<pre class="context-trace-audit__diff">${audit.diff}</pre>` : nothing}
			</section>
		`;
	}

	private renderOutcome(outcome: SafeTraceOutcomeRow) {
		const kind = OUTCOME_KIND_LABELS[outcome.kind] ?? "Extension activity";
		const status = OUTCOME_LABELS[outcome.outcome] ?? "Unknown outcome";
		// Do not surface losing, rejected, or failed proposal values even if a caller bypasses normalization.
		const selectionValue = outcome.outcome === "advised" || outcome.outcome === "applied"
			? outcome.selectionValue
			: undefined;
		// Defense in depth: render only fixed stage labels and bounded aggregate
		// telemetry, even when a caller constructs a component state directly.
		const capabilityStage = outcome.event === "sessionSetup" && outcome.kind === "decision"
			&& (outcome.capabilityStage === "skills" || outcome.capabilityStage === "mcp")
			? outcome.capabilityStage
			: undefined;
		const selectionFingerprint = capabilityStage && typeof outcome.selectionFingerprint === "string" && SELECTION_FINGERPRINT.test(outcome.selectionFingerprint)
			? outcome.selectionFingerprint
			: undefined;
		const candidateCount = capabilityStage ? safeDisplayNumber(outcome.candidateCount) : undefined;
		const selectedCount = capabilityStage ? safeDisplayNumber(outcome.selectedCount) : undefined;
		const selectorCount = capabilityStage ? safeDisplayNumber(outcome.selectorCount) : undefined;
		const contextBytesSaved = capabilityStage ? safeDisplayNumber(outcome.contextBytesSaved) : undefined;
		return html`
			<li class="context-trace-outcome" data-testid="context-trace-outcome">
				<div class="context-trace-outcome__header">
					<span class="context-trace-outcome__kind">${kind}</span>
					<span class="context-trace-outcome__status">${status}</span>
				</div>
				<dl class="context-trace-outcome__details">
					${outcome.packId ? html`<div><dt>Pack</dt><dd>${outcome.packId}</dd></div>` : nothing}
					<div><dt>Hook</dt><dd>${outcome.hookId}</dd></div>
					<div><dt>Event</dt><dd>${outcome.event}</dd></div>
					${outcome.requestId ? html`<div><dt>Request</dt><dd>${outcome.requestId}</dd></div>` : nothing}
					${outcome.questionId ? html`<div><dt>Question fingerprint</dt><dd>${outcome.questionId}</dd></div>` : nothing}
					${outcome.answer ? html`<div><dt>Answer</dt><dd>${outcome.answer}</dd></div>` : nothing}
					${outcome.defaultApplied !== undefined ? html`<div><dt>Default</dt><dd>${outcome.defaultApplied ? "Applied" : "Not applied"}</dd></div>` : nothing}
					${outcome.actor ? html`<div><dt>Actor</dt><dd>${outcome.actor}</dd></div>` : nothing}
					${outcome.decisionClass ? html`<div><dt>Decision class</dt><dd>${outcome.decisionClass}</dd></div>` : nothing}
					${outcome.decisionStatus ? html`<div><dt>Decision status</dt><dd>${outcome.decisionStatus}</dd></div>` : nothing}
					${outcome.classificationReason ? html`<div><dt>Classification</dt><dd>${outcome.classificationReason}</dd></div>` : nothing}
					${outcome.timeoutAction ? html`<div><dt>Timeout action</dt><dd>${outcome.timeoutAction}</dd></div>` : nothing}
					${outcome.resumeStatus ? html`<div><dt>Resume status</dt><dd>${outcome.resumeStatus}</dd></div>` : nothing}
					${outcome.selectionKind ? html`<div><dt>Selection kind</dt><dd>${outcome.selectionKind}</dd></div>` : nothing}
					${selectionValue ? html`<div><dt>Selection value</dt><dd>${selectionValue}</dd></div>` : nothing}
					${capabilityStage ? html`<div><dt>Selection stage</dt><dd>${CAPABILITY_STAGE_LABELS[capabilityStage]}</dd></div>` : nothing}
					${candidateCount !== undefined ? html`<div><dt>Eligible capabilities</dt><dd>${candidateCount}</dd></div>` : nothing}
					${selectedCount !== undefined ? html`<div><dt>Selected capabilities</dt><dd>${selectedCount}</dd></div>` : nothing}
					${selectorCount !== undefined ? html`<div><dt>Eligible selectors</dt><dd>${selectorCount}</dd></div>` : nothing}
					${contextBytesSaved !== undefined ? html`<div><dt>Context bytes saved</dt><dd>${contextBytesSaved}</dd></div>` : nothing}
					${selectionFingerprint ? html`<div><dt>Selection fingerprint</dt><dd>${selectionFingerprint}</dd></div>` : nothing}
					${outcome.reason ? html`<div><dt>Reason</dt><dd>${outcome.reason}</dd></div>` : nothing}
					${outcome.value ? html`<div><dt>Value</dt><dd>${outcome.value}</dd></div>` : nothing}
					${outcome.latencyMs !== undefined ? html`<div><dt>Duration</dt><dd>${outcome.latencyMs} ms</dd></div>` : nothing}
				</dl>
				${outcome.audit ? this.renderAudit(outcome.audit) : nothing}
			</li>
		`;
	}

	private renderEntries(items: ContextInspectorItem[]) {
		return html`
			<div class="context-trace-events" data-testid="context-trace-events">
				${items.map(({ entry }) => {
					const event = entry.hook;
					return html`
					<article class="context-trace-event" data-testid="context-trace-event" data-context-trace-hook=${event}>
						<div class="context-trace-event__header">
							<h3>${event}</h3>
							<time datetime=${machineTime(entry.ts)}>${localizedTime(entry.ts)}</time>
						</div>
						${entry.providers.length > 0
							? html`<ul class="context-trace-providers" aria-label="Providers for ${event}">${entry.providers.map((provider) => this.renderProvider(provider))}</ul>`
							: html`<p class="context-trace-muted">No provider activity was recorded.</p>`}
						${entry.outcomes?.length ? html`
							<section class="context-trace-activity" aria-label="Extension activity">
								<h4>Extension activity</h4>
								<ul class="context-trace-outcomes">${entry.outcomes.map((outcome) => this.renderOutcome(outcome))}</ul>
							</section>
						` : nothing}
					</article>
					`;
				})}
			</div>
		`;
	}

	override render() {
		const current = this.state || EMPTY_STATE;
		const items = Array.isArray(current.items) ? current.items : [];
		const initialLoading = current.status === "loading" && items.length === 0;
		const initialError = current.status === "error" && items.length === 0;
		const cachedError = current.refreshError && items.length > 0;
		const empty = current.status === "ready" && items.length === 0;
		const auditUnavailable = current.auditUnavailable === true;
		return html`
			<style>
				.context-trace-inspector { display:flex; flex:1; flex-direction:column; min-height:0; color:var(--foreground); background:var(--background); }
				.context-trace-inspector__header { display:flex; align-items:start; justify-content:space-between; gap:12px; padding:16px 16px 12px; border-bottom:1px solid var(--border); }
				.context-trace-inspector h2 { margin:0; font-size:15px; line-height:1.3; font-weight:650; outline-offset:3px; }
				.context-trace-inspector__support, .context-trace-muted, .context-trace-inspector__footer { margin:4px 0 0; color:var(--muted-foreground); font-size:12px; line-height:1.45; }
				.context-trace-button { appearance:none; border:1px solid var(--border); border-radius:5px; background:var(--background); color:var(--foreground); padding:5px 9px; font:inherit; font-size:12px; cursor:pointer; white-space:nowrap; }
				.context-trace-button:hover { background:var(--muted); }
				.context-trace-button:focus-visible { outline:2px solid var(--primary); outline-offset:2px; }
				.context-trace-inspector__body { flex:1; min-height:0; overflow:auto; padding:12px 16px 16px; }
				.context-trace-events { display:flex; flex-direction:column; gap:10px; }
				.context-trace-event { border:1px solid var(--border); border-radius:7px; background:var(--card); overflow:hidden; }
				.context-trace-event__header { display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:10px 12px; border-bottom:1px solid var(--border); }
				.context-trace-event h3 { margin:0; font-size:13px; font-weight:600; }
				.context-trace-event time { color:var(--muted-foreground); font-size:11px; text-align:right; }
				.context-trace-providers { display:flex; flex-direction:column; gap:0; margin:0; padding:0; list-style:none; }
				.context-trace-provider { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:6px 12px; padding:10px 12px; border-bottom:1px solid var(--border); }
				.context-trace-provider:last-child { border-bottom:0; }
				.context-trace-provider__name { overflow-wrap:anywhere; font:600 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
				.context-trace-provider__metrics { display:flex; gap:10px; margin:0; color:var(--muted-foreground); font-size:11px; }
				.context-trace-provider__metrics div { display:flex; gap:3px; }
				.context-trace-provider__metrics dt, .context-trace-provider__metrics dd { margin:0; }
				.context-trace-provider__metrics dt { color:var(--foreground); font-weight:600; }
				.context-trace-provider__status { grid-column:1 / -1; color:var(--warning); font-size:11px; }
				.context-trace-activity { padding:10px 12px; border-top:1px solid var(--border); }
				.context-trace-activity h4 { margin:0 0 7px; font-size:12px; font-weight:650; }
				.context-trace-outcomes { display:flex; flex-direction:column; gap:7px; margin:0; padding:0; list-style:none; }
				.context-trace-outcome { padding:8px; border:1px solid var(--border); border-radius:5px; background:color-mix(in oklch, var(--muted) 35%, transparent); }
				.context-trace-outcome__header { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
				.context-trace-outcome__kind { color:var(--muted-foreground); font-size:11px; text-transform:capitalize; }
				.context-trace-outcome__status { font-size:12px; font-weight:650; }
				.context-trace-outcome__details { display:flex; flex-wrap:wrap; gap:4px 10px; margin:6px 0 0; font-size:11px; }
				.context-trace-outcome__details div { display:flex; gap:3px; min-width:0; }
				.context-trace-outcome__details dt { color:var(--muted-foreground); }
				.context-trace-outcome__details dd { margin:0; overflow-wrap:anywhere; }
				.context-trace-audit { margin-top:9px; padding-top:9px; border-top:1px solid var(--border); }
				.context-trace-audit h5 { margin:0 0 6px; font-size:11px; font-weight:650; }
				.context-trace-audit__diff { max-height:240px; overflow:auto; margin:8px 0 0; padding:8px; border:1px solid var(--border); border-radius:4px; background:var(--background); color:var(--foreground); font:11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
				.context-trace-state { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:180px; gap:10px; text-align:center; color:var(--muted-foreground); font-size:13px; }
				.context-trace-skeleton { width:100%; height:58px; border-radius:7px; background:var(--muted); opacity:.65; }
				.context-trace-error { margin:0 0 12px; padding:9px 10px; border:1px solid var(--warning); border-radius:6px; background:color-mix(in oklch, var(--warning) 10%, transparent); color:var(--foreground); font-size:12px; }
				.context-trace-load { display:flex; justify-content:center; padding-top:12px; }
				.context-trace-inspector__footer { padding:10px 16px 14px; border-top:1px solid var(--border); }
				@media (max-width: 480px) { .context-trace-inspector__header, .context-trace-event__header { align-items:flex-start; flex-direction:column; } .context-trace-event time { text-align:left; } .context-trace-provider { grid-template-columns:1fr; } .context-trace-provider__metrics { flex-wrap:wrap; } }
			</style>
			<section class="context-trace-inspector" role="tabpanel" aria-label="Context trace" aria-busy=${initialLoading || current.isRefreshing ? "true" : "false"} data-testid="context-trace-inspector">
				<header class="context-trace-inspector__header">
					<div>
						<h2 tabindex="-1" data-context-trace-heading>Context trace</h2>
						<p class="context-trace-inspector__support">Read-only provider activity. Context contents are never shown.</p>
					</div>
					<button class="context-trace-button" type="button" aria-label="Refresh context trace" ?disabled=${initialLoading || current.isRefreshing} @click=${() => this.emit("context-trace-refresh")}>Refresh</button>
				</header>
				<div class="context-trace-inspector__body">
					${initialLoading ? html`<div class="context-trace-state" role="status"><span>Loading context trace…</span><div class="context-trace-skeleton" aria-hidden="true"></div><div class="context-trace-skeleton" aria-hidden="true"></div></div>` : nothing}
					${initialError ? html`<div class="context-trace-state" role="alert"><span>Context trace could not be loaded. </span><button class="context-trace-button" type="button" @click=${() => this.emit("context-trace-retry")}>Retry</button></div>` : nothing}
					${cachedError ? html`<div class="context-trace-error" role="alert">Could not refresh context trace. Showing the most recently loaded activity. <button class="context-trace-button" type="button" @click=${() => this.emit("context-trace-retry")}>Retry</button></div>` : nothing}
					${auditUnavailable ? html`<p class="context-trace-muted" data-testid="prompt-extension-audit-unavailable">Authorized prompt-extension details are temporarily unavailable.</p>` : nothing}
					${empty ? html`<div class="context-trace-state" data-testid="context-trace-empty">No context trace activity yet.</div>` : nothing}
					${items.length > 0 ? this.renderEntries(items) : nothing}
					${items.length > 0 && current.hasEarlier ? html`<div class="context-trace-load"><button class="context-trace-button" type="button" aria-label="Load 100 earlier context trace events" @click=${() => this.emit("context-trace-load-earlier")}>Load 100 earlier</button></div>` : nothing}
				</div>
				<footer class="context-trace-inspector__footer">Trace history is bounded; oldest events rotate out.</footer>
			</section>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"context-trace-inspector": ContextTraceInspector;
	}
}
