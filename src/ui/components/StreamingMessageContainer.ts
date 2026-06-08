import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { renderBlobSpriteImg } from "../bobbit-render.js";
import "./LiveTimer.js";

export class StreamingMessageContainer extends LitElement {
	@property({ type: Array }) tools: AgentTool[] = [];
	@property({ type: Boolean }) isStreaming = false;
	@property({ type: Boolean }) archived = false;

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
	private _exitTimer: ReturnType<typeof setTimeout> | null = null;
	private _compactEntryTimer: ReturnType<typeof setTimeout> | null = null;
	private _compactSafetyTimer: ReturnType<typeof setTimeout> | null = null;
	private _compactPopTimer: ReturnType<typeof setTimeout> | null = null;
	private _compactExitTimer: ReturnType<typeof setTimeout> | null = null;
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
		if (this.archived) return; // No animation state transitions when archived
		if (changed.has("isStreaming")) {
			// Defensive cleanup: when the agent transitions to NOT streaming and
			// we still have a stale in-flight `_message` cached, drop it. The
			// authoritative copy lives in the message-list; leaving the partial
			// rendered here on top produces the "duplicate Thinking bubble at
			// the end of an idle chat" bug. AgentInterface's `agent_end` /
			// `message_end` handlers already call `setMessage(null, true)` on
			// the happy path, but they can be bypassed by:
			//   • snapshot replays whose synthetic `message_end` loop predates
			//     the component being queried.
			//   • a status-only transition (heartbeat `session_status: idle`)
			//     after a missed `agent_end`.
			//   • a turn that ends via `error` / `aborted` before the agent
			//     emits a final `message_end` for the last `_message` snapshot.
			//   • a race where `setMessage(msg, false)`'s rAF fires AFTER
			//     `agent_end`'s `setMessage(null, true)` has cleared everything.
			// `isStreaming` is the single source of truth for "agent is doing
			// something" — if it's false, the container has no business
			// rendering an assistant card. Compaction owns its own visual
			// state and doesn't set `_message`, so this is safe to run
			// unconditionally on the transition.
			if (!this.isStreaming && this._message !== null) {
				this.setMessage(null, true);
			}
			// Compaction-state safety net: when the next turn starts streaming
			// (i.e. `isStreaming` flips to true) AND we're still in a compaction
			// animation state, force the compaction exit immediately. The
			// `endCompacting()` setTimeout SHOULD have already transitioned us
			// out, but if it was missed (compaction_end not received, race
			// during session switch, etc.) the sprite would otherwise stay
			// wedged in 'compacting' until the 10-minute safety timer fires.
			// Recognise the next turn as authoritative evidence that compaction
			// is done and clear the visual state.
			if (
				this.isStreaming
				&& (this._blobState === 'compact-shake'
					|| this._blobState === 'compacting'
					|| this._blobState === 'compact-pop')
			) {
				this._doEndCompacting();
				// Fall through to the regular isStreaming branches below so the
				// blob picks up its `active`/`entering` state for the new turn.
			}
			// Don't let agent_start/agent_end events override the compaction animation
			if (this._blobState === 'compact-shake' || this._blobState === 'compacting' || this._blobState === 'compact-pop' || this._compactEntryTimer) {
				// no-op — compaction owns the blob state until endCompacting() finishes
			} else if (this.isStreaming && this._blobState === 'idle') {
				// Coming from idle — play entry animation. Cancel any pending
				// exit timer so it can't later overwrite state back to 'idle'.
				if (this._exitTimer) {
					clearTimeout(this._exitTimer);
					this._exitTimer = null;
				}
				this._entryVariant = Math.random() < 0.5 ? 'enter' : 'enter-roll';
				this._blobState = 'entering';
				this._entryTimer = setTimeout(() => {
					this._entryTimer = null;
					this._blobState = 'active';
				}, this._entryVariant === 'enter-roll' ? 900 : 700);
			} else if (this.isStreaming) {
				// Cancel any pending exit timer so it can't strand the blob in
				// 'idle' while the agent is actively streaming.
				if (this._exitTimer) {
					clearTimeout(this._exitTimer);
					this._exitTimer = null;
				}
				this._blobState = 'active';
			} else if (this._blobState === 'active' || this._blobState === 'entering') {
				// Streaming stopped — cancel any pending entry timer and play exit
				if (this._entryTimer) {
					clearTimeout(this._entryTimer);
					this._entryTimer = null;
				}
				if (this._exitTimer) {
					clearTimeout(this._exitTimer);
					this._exitTimer = null;
				}
				this._exitVariant = Math.random() < 0.5 ? 'exit' : 'exit-roll';
				this._blobState = 'exiting';
				this._exitTimer = setTimeout(() => {
					this._exitTimer = null;
					// Guard: only go idle if streaming hasn't restarted and we
					// are still in 'exiting'. Otherwise a later isStreaming=true
					// transition has already taken ownership of the blob.
					if (!this.isStreaming && this._blobState === 'exiting') {
						this._blobState = 'idle';
					}
				}, this._exitVariant === 'exit-roll' ? 900 : 700);
			}
		}

	}

	private get _blobVisible() {
		if (this.archived) return true;
		return this._blobState !== 'hidden';
	}

	private get _blobClass() {
		if (this.archived) return 'bobbit-blob bobbit-blob--archived';

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
		// Compaction takes ownership of the blob — cancel any pending
		// entry/exit/pop timers that might otherwise overwrite our state.
		if (this._exitTimer) {
			clearTimeout(this._exitTimer);
			this._exitTimer = null;
		}
		if (this._entryTimer) {
			clearTimeout(this._entryTimer);
			this._entryTimer = null;
		}
		if (this._compactPopTimer) {
			clearTimeout(this._compactPopTimer);
			this._compactPopTimer = null;
		}
		if (this._compactExitTimer) {
			clearTimeout(this._compactExitTimer);
			this._compactExitTimer = null;
		}
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
		if (this._compactPopTimer) {
			clearTimeout(this._compactPopTimer);
			this._compactPopTimer = null;
		}
		if (this._compactExitTimer) {
			clearTimeout(this._compactExitTimer);
			this._compactExitTimer = null;
		}
		this._blobState = 'compact-pop';
		this._compactPopTimer = setTimeout(() => {
			this._compactPopTimer = null;
			this._exitVariant = Math.random() < 0.5 ? 'exit' : 'exit-roll';
			this._blobState = 'exiting';
			this._compactExitTimer = setTimeout(() => {
				this._compactExitTimer = null;
				// Guard: only go idle if streaming hasn't restarted and we
				// are still in 'exiting'.
				if (!this.isStreaming && this._blobState === 'exiting') {
					this._blobState = 'idle';
				}
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
			// Clear the flag synchronously: no rAF was scheduled in this branch,
			// so without this reset the flag would stay sticky-true and the next
			// batched setMessage(msg, false) rAF would silently drop its delta
			// (the !_immediateUpdate guard inside the rAF would short-circuit).
			this._immediateUpdate = false;
			return;
		}

		// Otherwise batch updates for performance during streaming
		if (!this._updateScheduled) {
			this._updateScheduled = true;

			requestAnimationFrame(async () => {
				// Only apply the update if we haven't been cleared
				if (!this._immediateUpdate && this._pendingMessage !== null) {
					// Shallow-copy the message so Lit sees a new reference and
					// propagates the change to child components (e.g.
					// <assistant-message>). This replaces the previous
					// JSON.parse(JSON.stringify()) deep clone which serialized
					// the entire message tree ~60x/sec during streaming.
					// A shallow copy is sufficient: child templates read
					// message.content (the array ref) directly, and the server
					// replaces the content array on each update rather than
					// mutating it in place.
					this._message = { ...this._pendingMessage } as AgentMessage;
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
		// Unified render: the blob lives in a single, stable DOM slot so its
		// CSS animations keep their clock across message transitions (e.g.
		// assistant → toolResult → next assistant). Previously each branch
		// returned a different html`` template, which caused Lit to tear down
		// and re-create the blob node on every transition — resetting the
		// bounce/squash/shadow keyframes to frame 0 and producing the jarring
		// restart the user reported.
		const msg = this._message;

		// Message content: only assistant messages render inline here. User
		// and toolResult messages are rendered by the stable message-list.
		let content: unknown = nothing;
		if (msg && msg.role === "assistant") {
			content = html`<assistant-message
				.message=${msg}
				.tools=${this.tools}
				.isStreaming=${this.isStreaming}
				.pendingToolCalls=${this.pendingToolCalls}
				.toolResultsById=${this.toolResultsById}
				.toolPartialResults=${this.toolPartialResults}
				.hideToolCalls=${false}
				.onCostClick=${this.onCostClick}
				.turnStartTime=${this.turnStartTime}
			></assistant-message>`;
		}

		const hasContent = content !== nothing;

		// Nothing to show at all — render empty.
		if (!hasContent && !this._blobVisible) return html``;

		// Live timer is only shown in the "no message yet" pre-stream state,
		// matching the previous behavior.
		const showTimer = !msg && this.isStreaming && this.turnStartTime;

		return html`
			<div class="flex flex-col gap-3 mb-3">
				${content}
				${this._blobVisible ? html`<div class="${this._blobClass}">
					${renderBlobSpriteImg(this._blobClass.includes("idle"), this.archived)}
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
					<div class="bobbit-blob__nurse-cap"></div>
					<div class="bobbit-blob__stamp"></div>
					<div class="bobbit-blob__clipboard"></div>
					<div class="bobbit-blob__shadow"></div>
					<div class="bobbit-blob__zzz" aria-hidden="true">
						<span class="bobbit-blob__zzz-letter bobbit-blob__zzz-letter--1">z</span>
						<span class="bobbit-blob__zzz-letter bobbit-blob__zzz-letter--2">z</span>
						<span class="bobbit-blob__zzz-letter bobbit-blob__zzz-letter--3">z</span>
					</div>
				</div>` : nothing}
				${showTimer
					? html`<div class="px-2 sm:px-4 text-xs text-muted-foreground text-right tabular-nums" style="margin-top:-32px;">
						<live-timer .startTime=${this.turnStartTime} .running=${true}></live-timer>
					</div>`
					: nothing}
			</div>
		`;
	}
}

// Register custom element
if (!customElements.get("streaming-message-container")) {
	customElements.define("streaming-message-container", StreamingMessageContainer);
}
