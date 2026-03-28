import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { renderBlobSpriteImg } from "../bobbit-render.js";
import "./LiveTimer.js";

export class StreamingMessageContainer extends LitElement {
	@property({ type: Array }) tools: AgentTool[] = [];
	@property({ type: Boolean }) isStreaming = false;

	@property({ type: Object }) pendingToolCalls?: Set<string>;
	@property({ type: Object }) toolResultsById?: Map<string, ToolResultMessage>;
	@property({ type: Object }) toolPartialResults?: Record<string, any>;
	@property({ attribute: false }) onCostClick?: () => void;
	@property({ type: Number }) turnStartTime: number | null = null;

	@state() private _message: AgentMessage | null = null;
	@state() private _blobState: 'hidden' | 'active' | 'entering' | 'exiting' | 'idle' | 'compact-shake' | 'compacting' | 'compact-pop' = 'idle';
	private _exitVariant: 'exit' | 'exit-roll' = 'exit';
	private _entryVariant: 'enter' | 'enter-roll' = 'enter';
	private _entryTimer: ReturnType<typeof setTimeout> | null = null;
	private _compactEntryTimer: ReturnType<typeof setTimeout> | null = null;
	private _compactSafetyTimer: ReturnType<typeof setTimeout> | null = null;
	private _compactStartedAt: number = 0;
	private _pendingMessage: AgentMessage | null = null;
	private _updateScheduled = false;
	private _immediateUpdate = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override updated(changed: Map<string, unknown>) {
		if (changed.has("isStreaming")) {
			// Don't let agent_start/agent_end events override the compaction animation
			if (this._blobState === 'compact-shake' || this._blobState === 'compacting' || this._blobState === 'compact-pop' || this._compactEntryTimer) {
				// no-op — compaction owns the blob state until endCompacting() finishes
			} else if (this.isStreaming && this._blobState === 'idle') {
				// Coming from idle — play entry animation
				this._entryVariant = Math.random() < 0.5 ? 'enter' : 'enter-roll';
				this._blobState = 'entering';
				this._entryTimer = setTimeout(() => {
					this._entryTimer = null;
					this._blobState = 'active';
				}, this._entryVariant === 'enter-roll' ? 900 : 700);
			} else if (this.isStreaming) {
				this._blobState = 'active';
			} else if (this._blobState === 'active' || this._blobState === 'entering') {
				// Streaming stopped — cancel any pending entry timer and play exit
				if (this._entryTimer) {
					clearTimeout(this._entryTimer);
					this._entryTimer = null;
				}
				this._exitVariant = Math.random() < 0.5 ? 'exit' : 'exit-roll';
				this._blobState = 'exiting';
				setTimeout(() => {
					this._blobState = 'idle';
				}, this._exitVariant === 'exit-roll' ? 900 : 700);
			}
		}

	}

	private get _blobVisible() {
		return this._blobState !== 'hidden';
	}

	private get _blobClass() {
		if (this._blobState === 'entering') return `bobbit-blob bobbit-blob--${this._entryVariant}`;
		if (this._blobState === 'exiting') return `bobbit-blob bobbit-blob--${this._exitVariant}`;
		if (this._blobState === 'idle') return 'bobbit-blob bobbit-blob--idle';
		if (this._blobState === 'compact-shake') return 'bobbit-blob bobbit-blob--compact-shake';
		if (this._blobState === 'compacting') return 'bobbit-blob bobbit-blob--compacting';
		if (this._blobState === 'compact-pop') return 'bobbit-blob bobbit-blob--compact-pop';
		return 'bobbit-blob';
	}

	private _compactShakeTimer: ReturnType<typeof setTimeout> | null = null;

	/** Start the compaction squash animation */
	public startCompacting() {
		this._compactStartedAt = Date.now();
		// If idle, enter first then shake then compact; if active, shake then compact
		const startShake = () => {
			this._blobState = 'compact-shake';
			this._compactShakeTimer = setTimeout(() => {
				this._compactShakeTimer = null;
				this._blobState = 'compacting';
			}, 800); // matches blob-compact-shake duration
		};
		if (this._blobState === 'idle') {
			this._entryVariant = Math.random() < 0.5 ? 'enter' : 'enter-roll';
			this._blobState = 'entering';
			this._compactEntryTimer = setTimeout(() => {
				this._compactEntryTimer = null;
				startShake();
			}, this._entryVariant === 'enter-roll' ? 900 : 700);
		} else {
			startShake();
		}
		// Safety timeout: if endCompacting() is never called (server error,
		// timeout, etc.), pop back after 2 minutes so the blob doesn't stay
		// squashed forever.
		if (this._compactSafetyTimer) clearTimeout(this._compactSafetyTimer);
		this._compactSafetyTimer = setTimeout(() => {
			this._compactSafetyTimer = null;
			if (this._blobState === 'compacting') this.endCompacting();
		}, 600_000);
	}

	/** Minimum time (ms) the compaction animation should play before ending.
	 *  Covers entry animation + visible squash time. */
	private static COMPACT_MIN_DURATION = 3500;

	/** End the compaction animation — pop back to size then go idle */
	public endCompacting() {
		// Ensure the animation plays for a minimum duration so the user
		// sees the squash even if the server responds instantly (e.g. error).
		const elapsed = Date.now() - (this._compactStartedAt ?? 0);
		const remaining = StreamingMessageContainer.COMPACT_MIN_DURATION - elapsed;
		if (remaining > 0 && this._blobState !== 'idle') {
			setTimeout(() => this._doEndCompacting(), remaining);
			return;
		}
		this._doEndCompacting();
	}

	private _doEndCompacting() {
		// Cancel any pending timers
		if (this._compactEntryTimer) {
			clearTimeout(this._compactEntryTimer);
			this._compactEntryTimer = null;
		}
		if (this._compactShakeTimer) {
			clearTimeout(this._compactShakeTimer);
			this._compactShakeTimer = null;
		}
		if (this._compactSafetyTimer) {
			clearTimeout(this._compactSafetyTimer);
			this._compactSafetyTimer = null;
		}
		this._blobState = 'compact-pop';
		setTimeout(() => {
			this._exitVariant = Math.random() < 0.5 ? 'exit' : 'exit-roll';
			this._blobState = 'exiting';
			setTimeout(() => {
				this._blobState = 'idle';
			}, this._exitVariant === 'exit-roll' ? 900 : 700);
		}, 600); // pop duration
	}

	// Public method to update the message with batching for performance
	public setMessage(message: AgentMessage | null, immediate = false) {
		// Store the latest message
		this._pendingMessage = message;

		// If this is an immediate update (like clearing), apply it right away
		if (immediate || message === null) {
			this._immediateUpdate = true;
			this._message = message;
			this.requestUpdate();
			// Cancel any pending updates since we're clearing
			this._pendingMessage = null;
			this._updateScheduled = false;
			return;
		}

		// Otherwise batch updates for performance during streaming
		if (!this._updateScheduled) {
			this._updateScheduled = true;

			requestAnimationFrame(async () => {
				// Only apply the update if we haven't been cleared
				if (!this._immediateUpdate && this._pendingMessage !== null) {
					// Deep clone the message to ensure Lit detects changes in nested properties
					// (like toolCall.arguments being mutated during streaming)
					this._message = JSON.parse(JSON.stringify(this._pendingMessage));
					this.requestUpdate();
				}
				// Reset for next batch
				this._pendingMessage = null;
				this._updateScheduled = false;
				this._immediateUpdate = false;
			});
		}
	}

	override render() {
		// Show loading indicator if loading but no message yet
		if (!this._message) {
			if (this._blobVisible)
				return html`<div class="flex flex-col gap-3 mb-3">
					<div class="${this._blobClass}">
						${renderBlobSpriteImg(this._blobClass.includes("idle"))}
						<div class="bobbit-blob__crown"></div>
						<div class="bobbit-blob__bandana"></div>
						<div class="bobbit-blob__magnifier"></div>
						<div class="bobbit-blob__palette"></div>
						<div class="bobbit-blob__pencil"></div>
						<div class="bobbit-blob__shield"></div>
						<div class="bobbit-blob__set-square"></div>
						<div class="bobbit-blob__flask"></div>
						<div class="bobbit-blob__wand"></div>
						<div class="bobbit-blob__wizard-hat"></div>
						<div class="bobbit-blob__shadow"></div>
					</div>
					${this.isStreaming && this.turnStartTime
						? html`<div class="px-2 sm:px-4 text-xs text-muted-foreground text-right tabular-nums" style="margin-top:-32px;">
							<live-timer .startTime=${this.turnStartTime} .running=${true}></live-timer>
						</div>`
						: nothing}
				</div>`;
			return html``; // Empty until a message is set
		}
		const msg = this._message;

		if (msg.role === "toolResult") {
			// Skip standalone tool result in streaming; the stable list will render paired tool-message
			return html``;
		} else if (msg.role === "user" || msg.role === "user-with-attachments") {
			// Skip standalone tool result in streaming; the stable list will render it immediiately
			return html``;
		} else if (msg.role === "assistant") {
			// Assistant message - render inline tool messages during streaming
			return html`
				<div class="flex flex-col gap-3 mb-3">
					<assistant-message
						.message=${msg}
						.tools=${this.tools}
						.isStreaming=${this.isStreaming}
						.pendingToolCalls=${this.pendingToolCalls}
						.toolResultsById=${this.toolResultsById}
						.toolPartialResults=${this.toolPartialResults}
						.hideToolCalls=${false}
						.onCostClick=${this.onCostClick}
						.turnStartTime=${this.turnStartTime}
					></assistant-message>
					${this._blobVisible ? html`<div class="${this._blobClass}">
						${renderBlobSpriteImg(this._blobClass.includes("idle"))}
						<div class="bobbit-blob__crown"></div>
						<div class="bobbit-blob__bandana"></div>
						<div class="bobbit-blob__magnifier"></div>
						<div class="bobbit-blob__palette"></div>
						<div class="bobbit-blob__pencil"></div>
						<div class="bobbit-blob__shield"></div>
						<div class="bobbit-blob__set-square"></div>
						<div class="bobbit-blob__flask"></div>
						<div class="bobbit-blob__wand"></div>
						<div class="bobbit-blob__wizard-hat"></div>
						<div class="bobbit-blob__shadow"></div>
					</div>` : ""}
				</div>
			`;
		}
	}
}

// Register custom element
if (!customElements.get("streaming-message-container")) {
	customElements.define("streaming-message-container", StreamingMessageContainer);
}
