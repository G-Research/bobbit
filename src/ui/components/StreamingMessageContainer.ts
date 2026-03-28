import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import "./LiveTimer.js";
import {
	renderBobbitToCanvas,
	CANONICAL_PALETTE,
	computeBounds,
	parseShadowToPixels,
	rotateHue,
	type Pixel,
	type BobbitPalette,
} from "../../app/bobbit-canvas.js";
import { ACCESSORIES, getAccessory } from "../../app/session-colors.js";

// ============================================================================
// Eye position data
// ============================================================================

/** Default (center) eye positions: top row + bottom row */
const EYES_CENTER_TOP: [number, number][] = [[3, 4], [6, 4]];
const EYES_CENTER_BOT: [number, number][] = [[3, 5], [6, 5]];

const EYES_RIGHT_TOP: [number, number][] = [[4, 4], [7, 4]];
const EYES_RIGHT_BOT: [number, number][] = [[4, 5], [7, 5]];

const EYES_LEFT_TOP: [number, number][] = [[2, 4], [5, 4]];
const EYES_LEFT_BOT: [number, number][] = [[2, 5], [5, 5]];

const EYES_UP_TOP: [number, number][] = [[4, 3], [7, 3]];
const EYES_UP_BOT: [number, number][] = [[4, 4], [7, 4]];

type EyeState = 'center' | 'blink-center' | 'right' | 'blink-right' | 'left' | 'blink-left' | 'up' | 'blink-up';

/** CSS class → accessory ID mapping */
const CLASS_TO_ACCESSORY: Record<string, string> = {
	"bobbit-crowned": "crown",
	"bobbit-bandana": "bandana",
	"bobbit-magnifier": "magnifier",
	"bobbit-palette": "palette",
	"bobbit-pencil": "pencil",
	"bobbit-shield": "shield",
	"bobbit-set-square": "set-square",
	"bobbit-flask": "flask",
	"bobbit-wizard-hat": "wizard-hat",
	"bobbit-wand": "wand",
};

/**
 * Determine the eye state for the busy blob animation.
 * 10-second cycle matching the old blob-busy-eyes CSS keyframes.
 */
function getBusyEyeState(pct: number): EyeState {
	if (pct < 16) return 'center';
	if (pct < 18) return 'blink-center';
	if (pct < 34) return 'center';
	if (pct < 36) return 'right';
	if (pct < 37) return 'blink-right';
	if (pct < 54) return 'right';
	if (pct < 60) return 'center';
	if (pct < 64) return 'up';
	if (pct < 65) return 'blink-up';
	if (pct < 68) return 'left';
	if (pct < 92) return 'center';
	if (pct < 94) return 'blink-center';
	if (pct < 96) return 'center';
	if (pct < 98) return 'right';
	return 'center';
}

/**
 * Determine the eye state for the idle blob animation.
 * 10-second cycle matching the old blob-idle-eyes CSS keyframes:
 * center → look left → blink-left → up-right → center →
 * look right → blink-right → up-right → center → blink-center
 */
function getIdleEyeState(pct: number): EyeState {
	if (pct < 10) return 'center';
	if (pct < 22) return 'left';
	if (pct < 25) return 'blink-left';
	if (pct < 45) return 'up';
	if (pct < 55) return 'center';
	if (pct < 67) return 'right';
	if (pct < 70) return 'blink-right';
	if (pct < 85) return 'up';
	if (pct < 93) return 'center';
	if (pct < 96) return 'blink-center';
	return 'center';
}

/**
 * Should the bandana tail be visible at this point in the 10s cycle?
 */
function isBandanaTailVisible(pct: number): boolean {
	if (pct < 34) return true;
	if (pct < 57) return false;
	if (pct < 60) return true;
	if (pct < 65) return false;
	if (pct < 96) return true;
	if (pct < 98) return false;
	return true;
}

/**
 * Get the eye pixel positions (top + bottom rows) for a given eye state.
 * For blink variants, only the bottom row is returned.
 */
function getEyePixels(eyeState: EyeState): { top: [number, number][]; bot: [number, number][] } {
	switch (eyeState) {
		case 'center':
			return { top: EYES_CENTER_TOP, bot: EYES_CENTER_BOT };
		case 'blink-center':
			return { top: [], bot: EYES_CENTER_BOT };
		case 'right':
			return { top: EYES_RIGHT_TOP, bot: EYES_RIGHT_BOT };
		case 'blink-right':
			return { top: [], bot: EYES_RIGHT_BOT };
		case 'left':
			return { top: EYES_LEFT_TOP, bot: EYES_LEFT_BOT };
		case 'blink-left':
			return { top: [], bot: EYES_LEFT_BOT };
		case 'up':
			return { top: EYES_UP_TOP, bot: EYES_UP_BOT };
		case 'blink-up':
			return { top: [], bot: EYES_UP_BOT };
	}
}

/** Detect the active accessory from document.documentElement.classList */
function detectAccessory(): string {
	const cl = document.documentElement.classList;
	for (const [cls, id] of Object.entries(CLASS_TO_ACCESSORY)) {
		if (cl.contains(cls)) return id;
	}
	return "none";
}

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

	// Canvas animation state
	private _canvas: HTMLCanvasElement = document.createElement("canvas");
	private _rafId: number | null = null;
	private _animStartTime: number = 0;
	private _lastEyeState: EyeState = 'center';
	private _lastTailVisible: boolean = true;
	private _canvasDrawn = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this._canvas.className = "bobbit-blob__sprite";
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._cancelAnimation();
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
				this._cancelAnimation();
				this._exitVariant = Math.random() < 0.5 ? 'exit' : 'exit-roll';
				this._blobState = 'exiting';
				setTimeout(() => {
					this._blobState = 'idle';
				}, this._exitVariant === 'exit-roll' ? 900 : 700);
			}
		}

		// Draw or start animation when the canvas first appears in the DOM
		if (this._blobVisible) {
			const canvasInDom = this.querySelector('.bobbit-blob__sprite') === this._canvas;
			if (canvasInDom && !this._canvasDrawn) {
				this._drawCanvas();
				this._canvasDrawn = true;
			}
			if ((this._blobState === 'active' || this._blobState === 'idle') && !this._rafId) {
				this._startAnimation();
			} else if (this._blobState !== 'active' && this._blobState !== 'idle' && this._rafId) {
				this._cancelAnimation();
				// Redraw with center eyes for non-active states
				this._drawCanvas();
			}
		} else {
			this._canvasDrawn = false;
			this._cancelAnimation();
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

	// ---- Canvas rendering ----

	/** Detect accessory and compute canvas options */
	private _getCanvasConfig() {
		const accId = detectAccessory();
		const acc = getAccessory(accId);
		const hasAccessory = acc.id !== "none" && acc.shadow !== "";
		const accPixels = hasAccessory ? parseShadowToPixels(acc.shadow) : undefined;
		// bodyYOffset=0: accessories share the body coordinate space.
		// Crown/wizard-hat extend above (y<0) and overlap the body naturally.
		const bounds = computeBounds(0, accPixels);
		const offX = -bounds.minX;
		const offY = -bounds.minY;
		return { acc, accPixels, bounds, offX, offY };
	}

	/** Draw the canvas with center eyes (static render) */
	private _drawCanvas(eyeState: EyeState = 'center', tailVisible = true) {
		const { acc, accPixels, offX, offY } = this._getCanvasConfig();

		// For bandana tail animation: filter out tail pixels when not visible
		let finalAccPixels = accPixels;
		if (acc.id === 'bandana' && accPixels && !tailVisible) {
			finalAccPixels = accPixels.filter(p => p.x < 10);
		}

		const palette = CANONICAL_PALETTE;

		// Read session hue rotation from CSS variable (set on documentElement)
		const hueStr = getComputedStyle(document.documentElement).getPropertyValue("--bobbit-hue-rotate").trim();
		const hueRotate = hueStr ? parseFloat(hueStr) || 0 : 0;

		// First render with default center eyes
		// renderScale=4 oversamples the buffer to match the CSS scale(4) transform,
		// so the GPU compositor maps 1:1 to buffer pixels — no bilinear blur.
		// hueRotate bakes the session colour into body pixels in JS so the CSS
		// filter on .bobbit-blob can be removed (it was rotating accessories too).
		renderBobbitToCanvas(this._canvas, {
			scale: 1,
			renderScale: 4,
			palette,
			accessoryPixels: finalAccPixels,
			
			hueRotate,
			accessoryHueRotate: acc.id === "flask",
		});

		// If eye state is not center, overdraw eyes
		if (eyeState !== 'center') {
			const dpr = window.devicePixelRatio || 1;
			const ctx = this._canvas.getContext("2d")!;
			ctx.save();
			// Must match renderScale (4) so eye overdraw aligns with the buffer
			ctx.scale(dpr * 4, dpr * 4);
			ctx.imageSmoothingEnabled = false;

			// Clear default eye positions by painting hue-rotated body main color
			const mainColor = hueRotate ? rotateHue(palette.main, hueRotate) : palette.main;
			for (const [ex, ey] of [...EYES_CENTER_TOP, ...EYES_CENTER_BOT]) {
				ctx.fillStyle = mainColor;
				ctx.fillRect(ex + offX, ey + offY, 1, 1);
			}

			// Paint new eye positions with hue-rotated eye color
			const eyeColor = hueRotate ? rotateHue(palette.eye, hueRotate) : palette.eye;
			const { top, bot } = getEyePixels(eyeState);
			for (const [ex, ey] of [...top, ...bot]) {
				ctx.fillStyle = eyeColor;
				ctx.fillRect(ex + offX, ey + offY, 1, 1);
			}

			ctx.restore();
		}

		// Set transform-origin dynamically based on accessory bounds
		this._canvas.style.transformOrigin = `${5 + offX}px ${8 + offY}px`;
	}

	/** Start the RAF animation loop for eye animation (active + idle states) */
	private _startAnimation() {
		this._animStartTime = performance.now();
		this._lastEyeState = 'center';
		this._lastTailVisible = true;
		this._drawCanvas('center', true);

		const tick = () => {
			if (this._blobState !== 'active' && this._blobState !== 'idle') {
				this._rafId = null;
				return;
			}

			const elapsed = performance.now() - this._animStartTime;
			const cycleDuration = 10000; // 10 seconds
			const pct = (elapsed % cycleDuration) / cycleDuration * 100;

			const eyeState = this._blobState === 'idle' ? getIdleEyeState(pct) : getBusyEyeState(pct);
			const accId = detectAccessory();
			const tailVisible = accId === 'bandana' ? isBandanaTailVisible(pct) : true;

			// Only redraw if state changed
			if (eyeState !== this._lastEyeState || tailVisible !== this._lastTailVisible) {
				this._lastEyeState = eyeState;
				this._lastTailVisible = tailVisible;
				this._drawCanvas(eyeState, tailVisible);
			}

			this._rafId = requestAnimationFrame(tick);
		};

		this._rafId = requestAnimationFrame(tick);
	}

	/** Cancel the RAF animation loop */
	private _cancelAnimation() {
		if (this._rafId !== null) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}
	}

	// ---- Compaction animation ----

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

	private _renderBlob() {
		const accId = detectAccessory();
		const sparkles = accId === 'wand'
			? html`<span class="bobbit-blob__sparkle bobbit-blob__sparkle--a"></span><span class="bobbit-blob__sparkle bobbit-blob__sparkle--b"></span>`
			: accId === 'flask'
			? html`<span class="bobbit-blob__bubble bobbit-blob__bubble--a"></span><span class="bobbit-blob__bubble bobbit-blob__bubble--b"></span>`
			: nothing;
		return html`<div class="${this._blobClass}">
			${this._canvas}
			${sparkles}
			<div class="bobbit-blob__shadow"></div>
		</div>`;
	}

	override render() {
		// Show loading indicator if loading but no message yet
		if (!this._message) {
			if (this._blobVisible)
				return html`<div class="flex flex-col gap-3 mb-3">
					${this._renderBlob()}
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
					${this._blobVisible ? this._renderBlob() : ""}
				</div>
			`;
		}
	}
}

// Register custom element
if (!customElements.get("streaming-message-container")) {
	customElements.define("streaming-message-container", StreamingMessageContainer);
}
