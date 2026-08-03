import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

export type ContextTraceEvent = "sessionSetup" | "beforePrompt" | "afterTurn" | "beforeCompact" | "sessionShutdown" | "Unknown event";

export interface SafeTraceProviderRow {
	id: string;
	latencyMs: number;
	keptBlocks: number;
	omittedBlocks: number;
	error?: "Timed out" | "Malformed blocks omitted" | "Provider error";
}

export interface SafeTraceEntry {
	/** `event` is retained for standalone renderer callers; the controller uses `hook`. */
	event?: ContextTraceEvent;
	hook?: ContextTraceEvent;
	ts: number;
	providers: SafeTraceProviderRow[];
}

export interface ContextTraceInspectorItem {
	kind: "trace";
	entry: SafeTraceEntry;
}

export interface ContextTraceState {
	status: "idle" | "loading" | "ready" | "error";
	items: ContextTraceInspectorItem[];
	isRefreshing?: boolean;
	canLoadEarlier?: boolean;
}

const EMPTY_STATE: ContextTraceState = { status: "idle", items: [] };

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
				${provider.error ? html`<span class="context-trace-provider__status" role="status">${provider.error}</span>` : nothing}
			</li>
		`;
	}

	private renderEntries(items: ContextTraceInspectorItem[]) {
		return html`
			<div class="context-trace-events" data-testid="context-trace-events">
				${items.map(({ entry }) => {
					const event = entry.event ?? entry.hook ?? "Unknown event";
					return html`
					<article class="context-trace-event" data-testid="context-trace-event" data-context-trace-hook=${event}>
						<div class="context-trace-event__header">
							<h3>${event}</h3>
							<time datetime=${machineTime(entry.ts)}>${localizedTime(entry.ts)}</time>
						</div>
						${entry.providers.length > 0
							? html`<ul class="context-trace-providers" aria-label="Providers for ${event}">${entry.providers.map((provider) => this.renderProvider(provider))}</ul>`
							: html`<p class="context-trace-muted">No provider activity was recorded.</p>`}
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
		const cachedError = current.status === "error" && items.length > 0;
		const empty = current.status === "ready" && items.length === 0;
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
				.context-trace-provider__metrics dt { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
				.context-trace-provider__metrics dd { margin:0; }
				.context-trace-provider__status { grid-column:1 / -1; color:var(--warning); font-size:11px; }
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
					${empty ? html`<div class="context-trace-state" data-testid="context-trace-empty">No context trace activity yet.</div>` : nothing}
					${items.length > 0 ? this.renderEntries(items) : nothing}
					${items.length > 0 && current.canLoadEarlier ? html`<div class="context-trace-load"><button class="context-trace-button" type="button" aria-label="Load 100 earlier context trace events" @click=${() => this.emit("context-trace-load-earlier")}>Load 100 earlier</button></div>` : nothing}
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
