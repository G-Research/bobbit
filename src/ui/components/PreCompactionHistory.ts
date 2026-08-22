import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { gatewayFetch } from "../../app/gateway-fetch.js";
import { gatewayRoute } from "../../shared/base-path.js";
import type { PromptAuthorAppearance } from "../../app/message-author-appearance.js";
import {
	NO_PROMPT_AUTHOR_LABELS,
	type PromptAuthorDisplayMode,
} from "../message-author-presentation.js";
import "./MessageList.js";

/**
 * Lazy, inline read-only transcript history shown immediately above a
 * compaction or context-clear boundary. Compaction remains the default contract
 * for existing callers; clear callers provide an independent boundary kind/id.
 * Loaded rows stay component-local and can never enter the live message state.
 */

interface VerboseHistoryRow {
	index: number;
	role: string;
	ts: string | null;
	content: unknown;
	message?: Record<string, unknown>;
}

interface HistoryEnvelope {
	total: number;
	returned: number;
	nextCursor: number | null;
	messages: VerboseHistoryRow[];
}

type HistoryBoundaryKind = "compaction" | "clear";
type ErrorPhase = "count" | "page" | null;

@customElement("bobbit-pre-compaction-history")
export class PreCompactionHistory extends LitElement {
	/** Backward-compatible compaction identity. */
	@property({ type: String, attribute: "compaction-id" }) compactionId: string = "";
	/** General boundary contract used by context clears. */
	@property({ type: String, attribute: "boundary-id" }) boundaryId: string = "";
	@property({ type: String, attribute: "boundary-kind" }) boundaryKind: HistoryBoundaryKind = "compaction";
	@property({ type: String, attribute: "session-id" }) sessionId: string = "";
	@property({ attribute: false }) promptAuthorDisplayMode: PromptAuthorDisplayMode = NO_PROMPT_AUTHOR_LABELS;
	@property({ attribute: false }) resolvePromptAuthorAppearance?: (author: unknown) => PromptAuthorAppearance;
	@property({ attribute: false }) reportPromptAuthorSlice?: (
		sessionId: string,
		boundaryId: string,
		messages: readonly unknown[] | undefined,
	) => void;

	@state() private _total: number | null = null;
	@state() private _loading = false;
	@state() private _error: string | null = null;
	@state() private _errorPhase: ErrorPhase = null;
	@state() private _expanded = false;
	@state() private _rows: VerboseHistoryRow[] = [];
	/** Lowest history index loaded; older pages prepend toward index zero. */
	@state() private _firstLoadedIndex = 0;

	private _observer: IntersectionObserver | null = null;
	private _countLoaded = false;
	private _inFlight = false;
	private _retryTimer: ReturnType<typeof setTimeout> | null = null;
	private _countRetries = 0;
	private _reportedSlice?: {
		reporter: NonNullable<PreCompactionHistory["reportPromptAuthorSlice"]>;
		sessionId: string;
		boundaryId: string;
	};
	/** Compaction cards can precede their sidecar by a beat; retain its bounded retry. */
	private static readonly MAX_COUNT_RETRIES = 8;

	protected override createRenderRoot() {
		return this;
	}

	private get _kind(): HistoryBoundaryKind {
		return this.boundaryKind === "clear" ? "clear" : "compaction";
	}

	private get _id(): string {
		return this.boundaryId || this.compactionId;
	}

	private get _reportId(): string {
		return this._kind === "clear" ? `clear:${this._id}` : this._id;
	}

	private get _testPrefix(): "pre-clear" | "pre-compaction" {
		return this._kind === "clear" ? "pre-clear" : "pre-compaction";
	}

	private get _controlsId(): string {
		return `bobbit-${this._testPrefix}-rows-${this._id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
	}

	private get _toggleId(): string {
		return `${this._controlsId}-toggle`;
	}

	private _requestUrl(cursor?: number, limit = 1, verbose = false): string {
		const route = this._kind === "clear" ? "before-clear" : "before-compaction";
		const idParam = this._kind === "clear" ? "clearId" : "compactionId";
		const params = new URLSearchParams({ [idParam]: this._id, limit: String(limit) });
		if (cursor !== undefined) params.set("cursor", String(cursor));
		if (verbose) params.set("verbose", "1");
		return gatewayRoute(
			`/api/sessions/${encodeURIComponent(this.sessionId)}/transcript/${route}?${params.toString()}`,
		);
	}

	override connectedCallback() {
		super.connectedCallback();
		queueMicrotask(() => {
			if (this.isConnected) this._syncPromptAuthorReport();
		});
		if (typeof IntersectionObserver !== "undefined") {
			this._observer = new IntersectionObserver((entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				void this._loadCount();
				this._observer?.disconnect();
				this._observer = null;
			}, { rootMargin: "200px" });
			queueMicrotask(() => this._observer?.observe(this));
			setTimeout(() => {
				if (!this._countLoaded && !this._inFlight && !this._retryTimer) void this._loadCount();
			}, 500);
		} else {
			void this._loadCount();
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this._clearPromptAuthorReport();
		this._observer?.disconnect();
		this._observer = null;
		if (this._retryTimer) clearTimeout(this._retryTimer);
		this._retryTimer = null;
	}

	protected override updated(changedProperties: PropertyValues<this>): void {
		if (
			changedProperties.has("_rows" as never)
			|| changedProperties.has("sessionId")
			|| changedProperties.has("compactionId")
			|| changedProperties.has("boundaryId")
			|| changedProperties.has("boundaryKind")
			|| changedProperties.has("reportPromptAuthorSlice")
		) this._syncPromptAuthorReport();
	}

	private _clearPromptAuthorReport(): void {
		const reported = this._reportedSlice;
		if (!reported) return;
		this._reportedSlice = undefined;
		reported.reporter(reported.sessionId, reported.boundaryId, undefined);
	}

	private _syncPromptAuthorReport(): void {
		const reporter = this.reportPromptAuthorSlice;
		const reportId = this._reportId;
		const identityChanged = !!this._reportedSlice && (
			this._reportedSlice.reporter !== reporter
			|| this._reportedSlice.sessionId !== this.sessionId
			|| this._reportedSlice.boundaryId !== reportId
		);
		if (identityChanged) this._clearPromptAuthorReport();

		const messages = this._hydrateMessages();
		if (!reporter || !this.sessionId || !reportId || messages.length === 0) {
			this._clearPromptAuthorReport();
			return;
		}
		reporter(this.sessionId, reportId, messages);
		this._reportedSlice = { reporter, sessionId: this.sessionId, boundaryId: reportId };
	}

	private _hydrateMessages(): Record<string, unknown>[] {
		// Keep the long-standing `orphan:` compaction key contract intact. Clear
		// rows use a separate boundary-qualified namespace so repeated folds can
		// never collide with each other or with active transcript rows.
		const prefix = this._kind === "clear" ? `preclear:${this._id}` : `orphan:${this._id}`;
		return this._rows
			.map((row) => row.message)
			.filter((message): message is Record<string, unknown> => !!message)
			.map((message, index) => ({
				...message,
				content: typeof message.content === "string"
					? [{ type: "text", text: message.content }]
					: message.content,
				id: typeof message.id === "string" && message.id.length > 0
					? `${prefix}:${message.id}`
					: `${prefix}:${index}`,
			}));
	}

	/** Public browser-test and user-retry hook. */
	async refreshCount(): Promise<void> {
		if (this._retryTimer) clearTimeout(this._retryTimer);
		this._retryTimer = null;
		this._countLoaded = false;
		this._countRetries = 0;
		this._total = null;
		this._error = null;
		this._errorPhase = null;
		await this._loadCount();
	}

	private _scheduleCountRetry(): boolean {
		if (this._countRetries >= PreCompactionHistory.MAX_COUNT_RETRIES) return false;
		this._countRetries++;
		const delay = Math.min(2000, 400 * this._countRetries);
		this._retryTimer = setTimeout(() => {
			this._retryTimer = null;
			void this._loadCount();
		}, delay);
		return true;
	}

	private async _loadCount(): Promise<void> {
		if (this._countLoaded || this._inFlight || !this.sessionId || !this._id) return;
		this._inFlight = true;
		try {
			const res = await gatewayFetch(this._requestUrl());
			if (!res.ok) {
				if (this._kind === "compaction" && res.status === 404 && this._scheduleCountRetry()) return;
				if (this._kind === "compaction") {
					if (res.status !== 404) console.warn(`[pre-compaction-history] count fetch HTTP ${res.status}`);
					this._countLoaded = true;
					this._total = 0;
					return;
				}
				this._countLoaded = true;
				this._total = 0;
				this._error = `Couldn’t load history (HTTP ${res.status}).`;
				this._errorPhase = "count";
				return;
			}
			const envelope = (await res.json()) as HistoryEnvelope;
			this._countLoaded = true;
			this._total = typeof envelope.total === "number" ? envelope.total : 0;
			this._error = null;
			this._errorPhase = null;
		} catch (error) {
			if (this._kind === "compaction" && this._scheduleCountRetry()) return;
			if (this._kind === "compaction") {
				console.warn("[pre-compaction-history] count fetch failed:", error);
				this._countLoaded = true;
				this._total = 0;
				return;
			}
			this._countLoaded = true;
			this._total = 0;
			this._error = "Couldn’t load history. Check your connection and try again.";
			this._errorPhase = "count";
		} finally {
			this._inFlight = false;
		}
	}

	/** Load the last 50 messages first. */
	private async _loadFirstPage(): Promise<void> {
		if (this._loading || (this._total ?? 0) <= 0) return;
		this._loading = true;
		this._error = null;
		this._errorPhase = null;
		const total = this._total ?? 0;
		const start = Math.max(0, total - 50);
		try {
			const res = await gatewayFetch(this._requestUrl(start, total - start, true));
			if (!res.ok) {
				this._error = `Couldn’t load history (HTTP ${res.status}).`;
				this._errorPhase = "page";
				return;
			}
			const envelope = (await res.json()) as HistoryEnvelope;
			this._rows = envelope.messages || [];
			this._firstLoadedIndex = start;
			if (typeof envelope.total === "number") this._total = envelope.total;
		} catch (error) {
			this._error = error instanceof Error ? error.message : String(error);
			this._errorPhase = "page";
		} finally {
			this._loading = false;
		}
	}

	private async _loadOlder(): Promise<void> {
		if (this._loading || this._firstLoadedIndex <= 0) return;
		this._loading = true;
		this._error = null;
		this._errorPhase = null;
		const start = Math.max(0, this._firstLoadedIndex - 50);
		const limit = this._firstLoadedIndex - start;
		try {
			const res = await gatewayFetch(this._requestUrl(start, limit, true));
			if (!res.ok) {
				this._error = `Couldn’t load history (HTTP ${res.status}).`;
				this._errorPhase = "page";
				return;
			}
			const envelope = (await res.json()) as HistoryEnvelope;
			this._rows = [...(envelope.messages || []), ...this._rows];
			this._firstLoadedIndex = start;
		} catch (error) {
			this._error = error instanceof Error ? error.message : String(error);
			this._errorPhase = "page";
		} finally {
			this._loading = false;
		}
	}

	private _onToggle(): void {
		this._expanded = !this._expanded;
		if (this._expanded && this._rows.length === 0 && !this._loading && (this._total ?? 0) > 0) {
			void this._loadFirstPage();
		}
	}

	private _retry = (): void => {
		if (this._errorPhase === "count") void this.refreshCount();
		else void this._loadFirstPage();
	};

	override render() {
		const testPrefix = this._testPrefix;
		const rootTestId = `${testPrefix}-history`;
		const boundaryAttr = this._kind === "clear" ? this._id : nothing;
		if (this._total === null) {
			return html`<div
				data-testid=${rootTestId}
				data-boundary-id=${boundaryAttr}
				data-state="loading"
			><span class="sr-only" role="status">Loading history…</span></div>`;
		}
		// Preserve the historical compaction behavior: zero orphan rows have no
		// affordance. Clear boundaries remain inspectable even when the preceding
		// generation was intentionally empty or its retained file is unavailable.
		if (this._total === 0 && this._kind === "compaction") {
			return html`<div data-testid=${rootTestId} data-state="empty"></div>`;
		}

		const total = this._total;
		const noun = total === 1 ? "message" : "messages";
		const relation = this._kind === "clear" ? "this clear" : "compaction";
		const olderRemaining = this._firstLoadedIndex;
		const hydratedMessages = this._hydrateMessages();
		return html`
			<div
				data-testid=${rootTestId}
				data-boundary-id=${boundaryAttr}
				data-state=${this._expanded ? "expanded" : "collapsed"}
				data-test-row-count=${this._rows.length}
				data-test-total=${total}
				style="margin-bottom:0.5rem;min-width:0;max-width:100%;"
			>
				<button
					id=${this._toggleId}
					type="button"
					@click=${this._onToggle}
					data-testid=${`${testPrefix}-toggle`}
					aria-expanded=${String(this._expanded)}
					aria-controls=${this._controlsId}
					class="inline-flex min-h-9 max-w-full items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
					style="background:none;border:none;padding:0.375rem 0;cursor:pointer;white-space:normal;"
				>
					<span aria-hidden="true">${this._expanded ? "▾" : "▸"}</span>
					${this._expanded ? "Hide" : "Show"} ${total} ${noun} before ${relation}
				</button>
				${this._expanded ? html`
					<div
						id=${this._controlsId}
						role="region"
						aria-labelledby=${this._toggleId}
						data-testid=${`${testPrefix}-rows`}
						data-boundary-id=${boundaryAttr}
						style="border-left:2px solid var(--border);padding-left:0.75rem;margin-top:0.5rem;opacity:0.7;min-width:0;max-width:100%;box-sizing:border-box;overflow-x:hidden;"
					>
						${this._error ? html`
							<div class="mb-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
								<span>${this._error}</span>
								<button type="button" class="min-h-8 underline" style="background:none;border:none;color:inherit;cursor:pointer;padding:0.25rem;" @click=${this._retry}>Try again</button>
							</div>
						` : nothing}
						${olderRemaining > 0 && !this._loading ? html`
							<button
								type="button"
								@click=${this._loadOlder}
								data-testid=${`${testPrefix}-load-more`}
								data-boundary-id=${boundaryAttr}
								class="min-h-9 text-xs text-muted-foreground hover:text-foreground"
								style="background:none;border:none;padding:0.375rem 0;cursor:pointer;margin-bottom:0.5rem;"
							>▲ Load ${Math.min(50, olderRemaining)} older</button>
						` : nothing}
						${this._loading ? html`<div class="text-xs text-muted-foreground" role="status">Loading…</div>` : nothing}
						<message-list
							.messages=${hydratedMessages as any}
							.isStreaming=${false}
							.hasStreamMessage=${false}
							.hideActionablePermissionRows=${true}
							.promptAuthorDisplayMode=${this.promptAuthorDisplayMode}
							.resolvePromptAuthorAppearance=${this.resolvePromptAuthorAppearance}
						></message-list>
					</div>
				` : nothing}
			</div>
		`;
	}
}
