import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { gatewayFetch } from "../../app/gateway-fetch.js";
import type { PromptAuthorAppearance } from "../../app/message-author-appearance.js";
import {
	NO_PROMPT_AUTHOR_LABELS,
	type PromptAuthorDisplayMode,
} from "../message-author-presentation.js";
import "./MessageList.js";

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

/** Verbose orphan row — the full agent message object plus index/ts decoration.
 *  Server returns this when `verbose=1`; we feed `row.message` into
 *  `<message-list>` which already knows how to render every agent message
 *  shape (user, assistant, toolResult, attachments, tool groups, …). */
interface VerboseOrphanRow {
	index: number;
	role: string;
	ts: string | null;
	content: unknown;
	message?: Record<string, unknown>;
}

interface OrphanEnvelope {
	total: number;
	returned: number;
	nextCursor: number | null;
	messages: VerboseOrphanRow[];
}

@customElement("bobbit-pre-compaction-history")
export class PreCompactionHistory extends LitElement {
	@property({ type: String, attribute: "compaction-id" }) compactionId: string = "";
	@property({ type: String, attribute: "session-id" }) sessionId: string = "";
	@property({ attribute: false }) promptAuthorDisplayMode: PromptAuthorDisplayMode = NO_PROMPT_AUTHOR_LABELS;
	@property({ attribute: false }) resolvePromptAuthorAppearance?: (author: unknown) => PromptAuthorAppearance;
	@property({ attribute: false }) reportPromptAuthorSlice?: (
		sessionId: string,
		compactionId: string,
		messages: readonly unknown[] | undefined,
	) => void;

	@state() private _total: number | null = null;
	@state() private _loading = false;
	@state() private _error: string | null = null;
	@state() private _expanded = false;
	@state() private _rows: VerboseOrphanRow[] = [];
	/** Lowest orphan index currently loaded. The window we hold is
	 *  `[_firstLoadedIndex, _firstLoadedIndex + _rows.length)`. Pagination
	 *  extends UPWARD — "Load older" at the top fetches
	 *  `[max(0, _firstLoadedIndex - 50), _firstLoadedIndex)` and prepends. */
	@state() private _firstLoadedIndex: number = 0;

	private _observer: IntersectionObserver | null = null;
	/** True once the count fetch has reached a TERMINAL outcome (a resolved
	 *  total, a non-retryable error, or an exhausted retry budget). While
	 *  retries are pending this stays false so the safety-net timer / IO can
	 *  still re-drive, but `_inFlight` / `_retryTimer` prevent overlap. */
	private _countLoaded = false;
	/** Guards against overlapping in-flight count fetches (IO hit + safety-net
	 *  timer + retry timer can all fire). */
	private _inFlight = false;
	/** Pending retry timer handle (transient-404 backoff). */
	private _retryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Number of transient-404 retries attempted so far. */
	private _countRetries = 0;
	private _reportedSlice?: {
		reporter: NonNullable<PreCompactionHistory["reportPromptAuthorSlice"]>;
		sessionId: string;
		compactionId: string;
	};
	/** Bounded retry budget for a freshly-minted compactionId whose sidecar
	 *  is written a beat AFTER the client mounts this widget (the live manual
	 *  `/compact` race: the card mounts on the `compaction_end` event, which
	 *  fires just before the server finishes appending the sidecar row). The
	 *  backoff schedule (≈400ms→2s, capped) tops out around 12s — comfortably
	 *  longer than the RPC-response propagation gap, but still bounded so a
	 *  genuinely-missing (legacy/purged) id collapses to no-affordance rather
	 *  than spinning forever. */
	private static readonly MAX_COUNT_RETRIES = 8;

	protected override createRenderRoot() {
		return this; // no shadow DOM so theme tokens cascade
	}

	override connectedCallback() {
		super.connectedCallback();
		// A previously hydrated instance can be detached and reinserted by a
		// keyed/deferred transcript render. Re-register it after connection;
		// first-mount property updates will harmlessly replace the same slice.
		queueMicrotask(() => {
			if (this.isConnected) this._syncPromptAuthorReport();
		});
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
			// (zero-height parent, animated reveal, headless quirks). Skip when a
			// retry is already pending so we don't short-circuit the backoff.
			setTimeout(() => {
				if (!this._countLoaded && !this._inFlight && !this._retryTimer) this._loadCount();
			}, 500);
		} else {
			// No IO support \u2014 fetch eagerly.
			this._loadCount();
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this._clearPromptAuthorReport();
		this._observer?.disconnect();
		this._observer = null;
		if (this._retryTimer) {
			clearTimeout(this._retryTimer);
			this._retryTimer = null;
		}
	}

	protected override updated(changedProperties: PropertyValues<this>): void {
		if (
			changedProperties.has("_rows" as never)
			|| changedProperties.has("sessionId")
			|| changedProperties.has("compactionId")
			|| changedProperties.has("reportPromptAuthorSlice")
		) {
			this._syncPromptAuthorReport();
		}
	}

	private _clearPromptAuthorReport(): void {
		const reported = this._reportedSlice;
		if (!reported) return;
		this._reportedSlice = undefined;
		reported.reporter(reported.sessionId, reported.compactionId, undefined);
	}

	private _syncPromptAuthorReport(): void {
		const reporter = this.reportPromptAuthorSlice;
		const identityChanged = !!this._reportedSlice && (
			this._reportedSlice.reporter !== reporter
			|| this._reportedSlice.sessionId !== this.sessionId
			|| this._reportedSlice.compactionId !== this.compactionId
		);
		if (identityChanged) this._clearPromptAuthorReport();

		const messages = this._hydrateMessages();
		if (!reporter || !this.sessionId || !this.compactionId || messages.length === 0) {
			this._clearPromptAuthorReport();
			return;
		}

		reporter(this.sessionId, this.compactionId, messages);
		this._reportedSlice = {
			reporter,
			sessionId: this.sessionId,
			compactionId: this.compactionId,
		};
	}

	private _hydrateMessages(): Record<string, unknown>[] {
		return this._rows
			.map((r) => r.message)
			.filter((m): m is Record<string, unknown> => !!m)
			.map((m, i) => {
				const content = typeof m.content === "string"
					? [{ type: "text", text: m.content }]
					: m.content;
				return {
					...m,
					content,
					id: typeof m.id === "string" && m.id.length > 0
						? `orphan:${this.compactionId}:${m.id}`
						: `orphan:${this.compactionId}:${i}`,
				};
			});
	}

	/** Public test/refresh hook: re-runs the count fetch from scratch.
	 *  Production paths never call this directly (IO + safety-net timer
	 *  handle initial load); browser E2E uses it to refetch after seeding
	 *  fixture data post-mount. */
	async refreshCount(): Promise<void> {
		if (this._retryTimer) {
			clearTimeout(this._retryTimer);
			this._retryTimer = null;
		}
		this._countLoaded = false;
		this._countRetries = 0;
		this._total = null;
		await this._loadCount();
	}

	/** Schedule a bounded backoff retry of the count fetch for a transient
	 *  404 (sidecar not persisted yet). Keeps `_total === null` so the widget
	 *  stays in its no-render "loading" state — no flash of the affordance,
	 *  and crucially no permanently-cached "empty". Returns true if a retry
	 *  was scheduled, false if the budget is exhausted. */
	private _scheduleCountRetry(): boolean {
		if (this._countRetries >= PreCompactionHistory.MAX_COUNT_RETRIES) return false;
		this._countRetries++;
		const delay = Math.min(2000, 400 * this._countRetries);
		this._retryTimer = setTimeout(() => {
			this._retryTimer = null;
			this._loadCount();
		}, delay);
		return true;
	}

	private async _loadCount(): Promise<void> {
		if (this._countLoaded || this._inFlight || !this.sessionId || !this.compactionId) return;
		this._inFlight = true;
		try {
			const res = await gatewayFetch(
				`/api/sessions/${encodeURIComponent(this.sessionId)}/transcript/before-compaction?compactionId=${encodeURIComponent(this.compactionId)}&limit=1`,
			);
			if (!res.ok) {
				// 404 compaction_not_found / transcript_unavailable is transient
				// right after a live (esp. manual) compaction: the widget mounts on
				// the `compaction_end` event a beat before the server appends the
				// sidecar row. Retry with bounded backoff before giving up so we
				// never permanently cache "empty" while the sidecar is still being
				// written. A genuinely-missing (legacy/purged) id exhausts the
				// budget and collapses to no-affordance.
				if (res.status === 404 && this._scheduleCountRetry()) return;
				if (res.status !== 404) {
					console.warn(`[pre-compaction-history] count fetch HTTP ${res.status}`);
				}
				this._countLoaded = true;
				this._total = 0;
				return;
			}
			const env = (await res.json()) as OrphanEnvelope;
			this._countLoaded = true;
			this._total = typeof env.total === "number" ? env.total : 0;
		} catch (err) {
			// Network/transport error — retry within budget too, then give up.
			if (this._scheduleCountRetry()) return;
			console.warn(`[pre-compaction-history] count fetch failed:`, err);
			this._countLoaded = true;
			this._total = 0;
		} finally {
			this._inFlight = false;
		}
	}

	/** Load the LAST 50 orphan messages first — the ones immediately
	 *  preceding the compaction. Reading backward through history matches
	 *  the natural "scroll up to see older" mental model. */
	private async _loadFirstPage(): Promise<void> {
		if (this._loading) return;
		this._loading = true;
		this._error = null;
		const PAGE = 50;
		const total = this._total ?? 0;
		const start = Math.max(0, total - PAGE);
		const limit = total - start;
		try {
			const res = await gatewayFetch(
				`/api/sessions/${encodeURIComponent(this.sessionId)}/transcript/before-compaction?compactionId=${encodeURIComponent(this.compactionId)}&cursor=${start}&limit=${limit}&verbose=1`,
			);
			if (!res.ok) {
				this._error = `Failed to load (HTTP ${res.status})`;
				return;
			}
			const env = (await res.json()) as OrphanEnvelope;
			this._rows = env.messages || [];
			this._firstLoadedIndex = start;
			if (typeof env.total === "number") this._total = env.total;
		} catch (err) {
			this._error = err instanceof Error ? err.message : String(err);
		} finally {
			this._loading = false;
		}
	}

	/** Extend the loaded window UPWARD by another page (toward index 0). */
	private async _loadOlder(): Promise<void> {
		if (this._loading || this._firstLoadedIndex <= 0) return;
		this._loading = true;
		this._error = null;
		const PAGE = 50;
		const newStart = Math.max(0, this._firstLoadedIndex - PAGE);
		const limit = this._firstLoadedIndex - newStart;
		try {
			const res = await gatewayFetch(
				`/api/sessions/${encodeURIComponent(this.sessionId)}/transcript/before-compaction?compactionId=${encodeURIComponent(this.compactionId)}&cursor=${newStart}&limit=${limit}&verbose=1`,
			);
			if (!res.ok) {
				this._error = `Failed to load (HTTP ${res.status})`;
				return;
			}
			const env = (await res.json()) as OrphanEnvelope;
			this._rows = [...(env.messages || []), ...this._rows];
			this._firstLoadedIndex = newStart;
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
		const olderRemaining = this._firstLoadedIndex;
		const hasOlder = olderRemaining > 0;
		// Hydrate verbose orphan rows into the same AgentMessage shape
		// `<message-list>` consumes for the live transcript. `row.message`
		// is the full `entry.message` object from the JSONL — typically already
		// in the right shape (role, content blocks, toolCallId for toolResult
		// rows, etc.). Normalise string-content (some fixtures and legacy
		// agent rows write `content: "hi"` directly) to the canonical
		// `[{ type: "text", text: ... }]` shape `<assistant-message>` expects.
		// Stamp a synthetic id so `<message-list>`'s diff key is stable.
		const hydratedMessages = this._hydrateMessages();
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
							style="border-left: 2px solid var(--border); padding-left: 0.75rem; margin-top: 0.5rem; opacity: 0.7;"
						>
							${this._error
								? html`<div class="text-xs text-destructive">${this._error}</div>`
								: nothing}
							${hasOlder && !this._loading
								? html`<button
									type="button"
									@click=${this._loadOlder}
									data-testid="pre-compaction-load-more"
									class="text-xs text-muted-foreground hover:text-foreground"
									style="background: none; border: none; padding: 0.25rem 0; cursor: pointer; margin-bottom: 0.5rem;"
								>\u25b2 Load ${Math.min(50, olderRemaining)} older</button>`
								: nothing}
							${this._loading
								? html`<div class="text-xs text-muted-foreground">Loading\u2026</div>`
								: nothing}
							<message-list
								.messages=${hydratedMessages as any}
								.isStreaming=${false}
								.hasStreamMessage=${false}
								.promptAuthorDisplayMode=${this.promptAuthorDisplayMode}
								.resolvePromptAuthorAppearance=${this.resolvePromptAuthorAppearance}
							></message-list>
						</div>
					`
					: nothing}
			</div>
		`;
	}
}
