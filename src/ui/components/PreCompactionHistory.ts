import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { gatewayFetch } from "../../app/gateway-fetch.js";

/**
 * Inline expansion above a compaction card showing the orphaned
 * pre-compaction transcript entries.
 *
 * Lifecycle:
 *   1. On first viewport hit (IntersectionObserver), fetches a
 *      `limit=1` count probe to learn `total`. Renders nothing when
 *      total === 0.
 *   2. Renders an affordance `\u25be Show N messages before compaction`.
 *   3. Click expands: fetches first page (limit=50), renders rows dimmed
 *      and pointer-events: none so the user can copy text but not
 *      interact. Paginated load-more if `nextCursor != null`.
 *
 * State is component-local; not persisted across reload (intentional \u2014
 * the collapsed default keeps reload noise low).
 *
 * See docs/design/persist-compaction-history.md \u00a75.3.
 */

interface OrphanRow {
	index: number;
	role: string;
	ts: string | null;
	text: string;
	toolUses?: Array<{ name: string; inputPreview: string }>;
	toolResults?: Array<{ name?: string; preview: string }>;
}

interface OrphanEnvelope {
	total: number;
	returned: number;
	nextCursor: number | null;
	messages: OrphanRow[];
}

@customElement("bobbit-pre-compaction-history")
export class PreCompactionHistory extends LitElement {
	@property({ type: String, attribute: "compaction-id" }) compactionId: string = "";
	@property({ type: String, attribute: "session-id" }) sessionId: string = "";

	@state() private _total: number | null = null;
	@state() private _loading = false;
	@state() private _error: string | null = null;
	@state() private _expanded = false;
	@state() private _rows: OrphanRow[] = [];
	@state() private _nextCursor: number | null = null;

	private _observer: IntersectionObserver | null = null;
	private _countLoaded = false;

	protected override createRenderRoot() {
		return this; // no shadow DOM so theme tokens cascade
	}

	override connectedCallback() {
		super.connectedCallback();
		// Lazy count fetch on first viewport hit. Prefetch slack via
		// rootMargin keeps cards just below the fold from showing a flash
		// of the affordance after scrolling.
		if (typeof IntersectionObserver !== "undefined") {
			this._observer = new IntersectionObserver((entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						this._loadCount();
						this._observer?.disconnect();
						this._observer = null;
						break;
					}
				}
			}, { rootMargin: "200px" });
			// Defer to after first paint so getBoundingClientRect is valid.
			queueMicrotask(() => {
				if (this._observer) this._observer.observe(this);
			});
			// Safety-net eager fetch after 500ms in case IO never fires
			// (zero-height parent, animated reveal, headless quirks).
			setTimeout(() => { if (!this._countLoaded) this._loadCount(); }, 500);
		} else {
			// No IO support \u2014 fetch eagerly.
			this._loadCount();
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this._observer?.disconnect();
		this._observer = null;
	}

	/** Public test/refresh hook: re-runs the count fetch from scratch.
	 *  Production paths never call this directly (IO + safety-net timer
	 *  handle initial load); browser E2E uses it to refetch after seeding
	 *  fixture data post-mount. */
	async refreshCount(): Promise<void> {
		this._countLoaded = false;
		this._total = null;
		await this._loadCount();
	}

	private async _loadCount(): Promise<void> {
		if (this._countLoaded || !this.sessionId || !this.compactionId) return;
		this._countLoaded = true;
		try {
			const res = await gatewayFetch(
				`/api/sessions/${encodeURIComponent(this.sessionId)}/transcript/before-compaction?compactionId=${encodeURIComponent(this.compactionId)}&limit=1`,
			);
			if (!res.ok) {
				// 404 compaction_not_found / transcript_unavailable \u2014 silent
				// (collapse to no affordance). Other errors logged.
				if (res.status !== 404) {
					console.warn(`[pre-compaction-history] count fetch HTTP ${res.status}`);
				}
				this._total = 0;
				return;
			}
			const env = (await res.json()) as OrphanEnvelope;
			this._total = typeof env.total === "number" ? env.total : 0;
		} catch (err) {
			console.warn(`[pre-compaction-history] count fetch failed:`, err);
			this._total = 0;
		}
	}

	private async _loadFirstPage(): Promise<void> {
		if (this._loading) return;
		this._loading = true;
		this._error = null;
		try {
			const res = await gatewayFetch(
				`/api/sessions/${encodeURIComponent(this.sessionId)}/transcript/before-compaction?compactionId=${encodeURIComponent(this.compactionId)}&limit=50`,
			);
			if (!res.ok) {
				this._error = `Failed to load (HTTP ${res.status})`;
				return;
			}
			const env = (await res.json()) as OrphanEnvelope;
			this._rows = env.messages || [];
			this._nextCursor = env.nextCursor ?? null;
			if (typeof env.total === "number") this._total = env.total;
		} catch (err) {
			this._error = err instanceof Error ? err.message : String(err);
		} finally {
			this._loading = false;
		}
	}

	private async _loadMore(): Promise<void> {
		if (this._loading || this._nextCursor == null) return;
		this._loading = true;
		this._error = null;
		try {
			const res = await gatewayFetch(
				`/api/sessions/${encodeURIComponent(this.sessionId)}/transcript/before-compaction?compactionId=${encodeURIComponent(this.compactionId)}&cursor=${this._nextCursor}&limit=50`,
			);
			if (!res.ok) {
				this._error = `Failed to load (HTTP ${res.status})`;
				return;
			}
			const env = (await res.json()) as OrphanEnvelope;
			this._rows = [...this._rows, ...(env.messages || [])];
			this._nextCursor = env.nextCursor ?? null;
		} catch (err) {
			this._error = err instanceof Error ? err.message : String(err);
		} finally {
			this._loading = false;
		}
	}

	private _onToggle(): void {
		if (this._expanded) {
			this._expanded = false;
			return;
		}
		this._expanded = true;
		if (this._rows.length === 0 && !this._loading) {
			this._loadFirstPage();
		}
	}

	override render() {
		// Pre-count: render a placeholder distinguishable from total=0 so
		// test harnesses can tell "haven't fetched yet" from "genuinely empty".
		if (this._total === null) {
			return html`<div data-testid="pre-compaction-history" data-state="loading"></div>`;
		}
		if (this._total === 0) {
			return html`<div data-testid="pre-compaction-history" data-state="empty"></div>`;
		}
		const stateAttr = this._expanded ? "expanded" : "collapsed";
		const chevron = this._expanded ? "\u25be" : "\u25b8";
		const remaining = this._nextCursor != null ? Math.max(0, this._total - this._rows.length) : 0;
		return html`
			<div
				data-testid="pre-compaction-history"
				data-state=${stateAttr}
				data-test-row-count=${this._rows.length}
				data-test-total=${this._total}
				style="margin-bottom: 0.5rem;"
			>
				<button
					type="button"
					@click=${this._onToggle}
					data-testid="pre-compaction-toggle"
					class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
					style="background: none; border: none; padding: 0.25rem 0; cursor: pointer;"
				>
					<span aria-hidden="true">${chevron}</span>
					${this._expanded
						? html`Hide ${this._total} message${this._total === 1 ? "" : "s"} before compaction`
						: html`Show ${this._total} message${this._total === 1 ? "" : "s"} before compaction`}
				</button>
				${this._expanded
					? html`
						<div
							data-testid="pre-compaction-rows"
							style="border-left: 2px solid var(--border); padding-left: 0.75rem; margin-top: 0.5rem; opacity: 0.65; user-select: text; pointer-events: none;"
						>
							${this._error
								? html`<div class="text-xs text-destructive" style="pointer-events: auto;">${this._error}</div>`
								: nothing}
							${this._rows.map((r) => this._renderRow(r))}
							${this._loading
								? html`<div class="text-xs text-muted-foreground">Loading\u2026</div>`
								: nothing}
							${this._nextCursor != null && !this._loading
								? html`<button
									type="button"
									@click=${this._loadMore}
									data-testid="pre-compaction-load-more"
									class="text-xs text-muted-foreground hover:text-foreground"
									style="background: none; border: none; padding: 0.25rem 0; cursor: pointer; pointer-events: auto; margin-top: 0.5rem;"
								>\u25bc Load ${Math.min(50, remaining)} more</button>`
								: nothing}
						</div>
					`
					: nothing}
			</div>
		`;
	}

	private _renderRow(r: OrphanRow) {
		const roleLabel = r.role === "assistant" ? "Assistant" : r.role === "user" ? "You" : r.role;
		return html`
			<div
				data-testid="pre-compaction-row"
				data-role=${r.role}
				style="margin: 0.5rem 0; font-size: 0.875rem;"
			>
				<div style="font-weight: 600; font-size: 0.75rem; color: var(--muted-foreground); margin-bottom: 0.25rem;">
					${roleLabel}${r.ts ? html` \u00b7 <span>${r.ts}</span>` : nothing}
				</div>
				${r.text
					? html`<div style="white-space: pre-wrap; overflow-wrap: anywhere;">${r.text}</div>`
					: nothing}
				${r.toolUses && r.toolUses.length > 0
					? html`<div style="font-size: 0.75rem; color: var(--muted-foreground); margin-top: 0.25rem;">
						${r.toolUses.map((t) => html`<div>\u2192 ${t.name}</div>`)}
					</div>`
					: nothing}
				${r.toolResults && r.toolResults.length > 0
					? html`<div style="font-size: 0.75rem; color: var(--muted-foreground); margin-top: 0.25rem;">
						${r.toolResults.map((t) => html`<div>\u2190 ${t.name || "result"}</div>`)}
					</div>`
					: nothing}
			</div>
		`;
	}
}
