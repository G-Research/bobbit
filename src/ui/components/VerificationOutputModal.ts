/**
 * <verification-output-modal> — Modal overlay showing live streaming output
 * from a command verification step. Dark terminal-style, monospace font,
 * auto-scrolls to bottom unless user scrolled up.
 */
import { LitElement, html, nothing, render as litRender, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { ensureMarkdownBlock } from "../lazy/markdown-block.js";
import { ansiToHtml, hasAnsi } from "../utils/ansi.js";
import { getVerificationEventKey } from "../../app/verification-event-bus.js";

interface OutputChunk {
	stream: "stdout" | "stderr";
	text: string;
}

@customElement("verification-output-modal")
export class VerificationOutputModal extends LitElement {
	@property() goalId = "";
	@property() gateId = "";
	@property() signalId = "";
	@property({ type: Number }) stepIndex = 0;
	@property() stepName = "";
	@property({ type: Boolean }) open = false;
	@property() initialOutput = "";
	@property() stepType = "";

	@state() private _chunks: OutputChunk[] = [];
	@state() private _completed = false;
	@state() private _finalStatus: "passed" | "failed" | "" = "";

	private _userScrolledUp = false;
	/** Per-instance dedupe window — collapses identical events delivered via
	 * the document-level fan-out (one per session WS in the goal). Keyed by
	 * `getVerificationEventKey(detail)`. Bounded to prevent unbounded growth
	 * during very long verifications. */
	private _seenEvents: Set<string> = new Set();
	private _seenEventsOrder: string[] = [];
	private static readonly _SEEN_CAP = 2048;
	/** Highest `seq` already accounted for via `initialOutput` bootstrap.
	 * Live events with `seq` <= this are treated as duplicates. */
	private _bootstrapSeqHighWater = -1;
	private _abortCtrl?: AbortController;
	/** Overlay is portaled to document.body so its `position: fixed` is
	 * relative to the viewport. The chat message-list applies
	 * `content-visibility: auto` (⇒ `contain`), which would otherwise make an
	 * ancestor the containing block and clip the modal into the message box. */
	private _portalEl: HTMLDivElement | null = null;

	override createRenderRoot() { return this; }

	override connectedCallback() {
		ensureMarkdownBlock();
		super.connectedCallback();
		this._abortCtrl = new AbortController();
		const signal = this._abortCtrl.signal;
		document.addEventListener("gate-verification-event", (e) => this._onEvent(e), { signal });
		document.addEventListener("keydown", (e) => this._onKeyDown(e as KeyboardEvent), { signal });
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this._abortCtrl?.abort();
		this._abortCtrl = undefined;
		this._seenEvents.clear();
		this._seenEventsOrder.length = 0;
		this._removePortal();
	}

	private _renderPortal() {
		if (!this._portalEl) {
			this._portalEl = document.createElement("div");
			document.body.appendChild(this._portalEl);
		}
		// Pass `host: this` so `@click`/`@scroll` handlers are invoked with `this`
		// bound to the component (not the portal DOM node). Without it, _close()
		// would dispatch the "close" event on the wrong element and the parent's
		// @close listener (and backdrop-click close) would never fire.
		litRender(this._overlayTemplate(), this._portalEl, { host: this });
	}

	private _removePortal() {
		if (this._portalEl) {
			litRender(nothing, this._portalEl);
			this._portalEl.remove();
			this._portalEl = null;
		}
	}

	private _markEventSeen(key: string): boolean {
		if (!key) return true;
		if (this._seenEvents.has(key)) return false;
		this._seenEvents.add(key);
		this._seenEventsOrder.push(key);
		if (this._seenEventsOrder.length > VerificationOutputModal._SEEN_CAP) {
			const evict = this._seenEventsOrder.shift();
			if (evict !== undefined) this._seenEvents.delete(evict);
		}
		return true;
	}

	override updated(changed: Map<string, unknown>) {
		if (changed.has("open") && this.open) {
			// Reset state when opened
			this._chunks = [];
			this._completed = false;
			this._finalStatus = "";
			this._userScrolledUp = false;
			this._seenEvents.clear();
			this._seenEventsOrder.length = 0;
			this._bootstrapSeqHighWater = -1;
			// Parse initialOutput as stdout
			if (this.initialOutput) {
				this._chunks = [{ stream: "stdout", text: this.initialOutput }];
				// If the caller passed a `seq` boundary alongside initialOutput,
				// honour it so live events <= that seq are dropped.
				const seq = (this as any).initialOutputSeq;
				if (typeof seq === "number") this._bootstrapSeqHighWater = seq;
			} else if (this.goalId && this.signalId) {
				// Bootstrap from API only when we don't already have content.
				this._fetchBootstrapOutput();
			}
			this._renderPortal();
			// Auto-scroll after render
			requestAnimationFrame(() => this._scrollToBottom());
		} else if (changed.has("open") && !this.open) {
			this._removePortal();
		} else if (this.open && this._portalEl) {
			// State changed while open (streamed chunks, completion) — the overlay
			// lives outside Lit's render tree, so re-render the portal manually.
			this._renderPortal();
		}
	}

	private async _fetchBootstrapOutput(): Promise<void> {
		try {
			const token = localStorage.getItem("gateway.token") || "";
			const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
			const res = await fetch(`/api/goals/${this.goalId}/verifications/active`, { headers });
			if (!res.ok) return;
			const data = await res.json();
			const verifications: Array<any> = data.verifications || [];
			const match = verifications.find((v: any) => v.signalId === this.signalId);
			if (!match) return;
			const step = match.steps?.[this.stepIndex];
			if (step?.output && this._chunks.length === 0) {
				this._chunks = [{ stream: "stdout", text: step.output }];
				this.requestUpdate();
				requestAnimationFrame(() => this._scrollToBottom());
			}
		} catch {
			// Non-fatal — live WS events will still work
		}
	}

	private _onEvent(e: Event) {
		const detail = (e as CustomEvent).detail;
		if (!detail || !this.open) return;
		if (detail.signalId !== this.signalId) return;

		// Per-instance dedupe — the same payload may be redispatched on
		// `document` once per session WS in the goal team (see
		// verification-event-bus.ts).
		const key = getVerificationEventKey(detail);
		if (!this._markEventSeen(key)) return;

		if (detail.type === "gate_verification_step_output" && detail.stepIndex === this.stepIndex) {
			// If the event is part of the bootstrap prefix already shown via
			// `initialOutput`, skip the live append to avoid double-printing.
			if (typeof detail.seq === "number" && detail.seq <= this._bootstrapSeqHighWater) return;
			this._chunks = [...this._chunks, { stream: detail.stream, text: detail.text }];
			if (!this._userScrolledUp) {
				requestAnimationFrame(() => this._scrollToBottom());
			}
		}

		if (detail.type === "gate_verification_step_complete" && detail.stepIndex === this.stepIndex) {
			this._completed = true;
			this._finalStatus = detail.status === "passed" ? "passed" : "failed";
		}
	}

	private _onKeyDown(e: KeyboardEvent) {
		if (e.key === "Escape" && this.open) {
			this._close();
		}
	}

	private _onScroll(e: Event) {
		const el = e.target as HTMLElement;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
		this._userScrolledUp = !atBottom;
	}

	private _scrollToBottom() {
		const el = this._portalEl?.querySelector(".verif-output-body");
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}

	private _close() {
		this.dispatchEvent(new Event("close"));
	}

	private _onBackdropClick(e: Event) {
		if ((e.target as HTMLElement).classList.contains("verif-output-backdrop")) {
			this._close();
		}
	}
	// Host element renders nothing — the overlay is portaled to document.body.
	override render(): typeof nothing {
		return nothing;
	}

	private _overlayTemplate(): TemplateResult | typeof nothing {
		if (!this.open) return nothing;

		return html`
			<div class="verif-output-backdrop fixed inset-0 z-50 flex items-center justify-center"
				style="background:rgba(0,0,0,0.6);backdrop-filter:blur(2px);"
				@click=${this._onBackdropClick}>
				<div class="verif-output-container flex flex-col rounded-lg overflow-hidden shadow-2xl"
					style="background:#18181b;max-width:56rem;width:calc(100% - 2rem);max-height:80vh;">
					<!-- Header -->
					<div class="flex items-center justify-between px-4 py-2.5 border-b" style="border-color:#27272a;">
						<div class="flex items-center gap-2">
							${this._completed
								? html`<span class="${this._finalStatus === "passed" ? "text-green-500" : "text-red-500"}">${this._finalStatus === "passed" ? "\u2713" : "\u2717"}</span>`
								: html`<span class="text-amber-400 animate-pulse">\u25CF</span>`}
							<span class="font-mono text-sm" style="color:#d4d4d8;">${this.stepName || `Step ${this.stepIndex + 1}`}</span>
							${this._completed ? html`
								<span class="text-xs px-1.5 py-0.5 rounded ${this._finalStatus === "passed" ? "text-green-400" : "text-red-400"}"
									style="background:${this._finalStatus === "passed" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)"}">
									${this._finalStatus}
								</span>
							` : html`
								<span class="text-xs px-1.5 py-0.5 rounded text-amber-400" style="background:rgba(245,158,11,0.15)">running</span>
							`}
						</div>
						<button class="text-zinc-400 hover:text-zinc-200 transition-colors" style="font-size:18px;line-height:1;padding:2px 6px;" @click=${this._close} title="Close">\u2715</button>
					</div>
					<!-- Body -->
					${this._isAgentStep()
						? html`<div class="verif-output-body flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed"
							style="background:#18181b;margin:0;color:#d4d4d8;"
							@scroll=${this._onScroll}>${this._renderMarkdownOutput()}</div>`
						: html`<pre class="verif-output-body flex-1 overflow-y-auto px-4 py-3 text-xs leading-relaxed"
							style="background:#18181b;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;margin:0;white-space:pre-wrap;word-break:break-all;"
							@scroll=${this._onScroll}>${this._renderOutput()}</pre>`
					}
				</div>
			</div>
		`;
	}

	private _isAgentStep(): boolean {
		return this.stepType !== "" && this.stepType !== "command";
	}

	private _renderMarkdownOutput(): TemplateResult {
		if (this._chunks.length === 0) {
			return html`<span style="color:#71717a;">Waiting for output\u2026</span>`;
		}
		const joined = this._chunks.map(c => c.text).join("");
		return html`<markdown-block .content=${joined}></markdown-block>`;
	}

	private _renderOutput(): TemplateResult {
		if (this._chunks.length === 0) {
			return html`<span style="color:#71717a;">Waiting for output\u2026</span>`;
		}
		return html`${this._chunks.map(c => {
			if (hasAnsi(c.text)) {
				return html`<span style="color:${c.stream === "stderr" ? "#fbbf24" : "#d4d4d8"};">${unsafeHTML(ansiToHtml(c.text))}</span>`;
			}
			return c.stream === "stderr"
				? html`<span style="color:#fbbf24;">${c.text}</span>`
				: html`<span style="color:#d4d4d8;">${c.text}</span>`;
		})}`;
	}
}
