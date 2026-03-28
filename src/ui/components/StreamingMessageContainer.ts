import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import "./LiveTimer.js";
import {
	type EyeState,
	BobbitEyeTimer,
	BUSY_EYE_SCHEDULE,
	IDLE_EYE_SCHEDULE,
	drawBobbitSprite,
	onDprChange,
	ACCESSORY_PIXELS,
	counterHueRotate,
} from "../bobbit-sprite.js";
import { getAccessory } from "../../app/session-colors.js";

/**
 * Paint only the accessory pixels onto a canvas.
 * For the chat blob, accessories are separate elements with their own CSS animations.
 */
function drawAccessoryCanvas(
	canvas: HTMLCanvasElement,
	accessoryId: string,
	opts: { scale?: number; dpr?: number; hueRotate?: number; excludeTail?: boolean; cssScale?: number; },
): void {
	const pixels = ACCESSORY_PIXELS[accessoryId];
	if (!pixels || pixels.length === 0) return;

	const scale = opts.scale ?? 4;
	const dpr = opts.dpr ?? window.devicePixelRatio;
	const pxSize = Math.max(1, Math.round(scale * dpr));

	// Filter tail pixels for bandana when facing right/up
	let paintPixels = pixels;
	if (opts.excludeTail && accessoryId === 'bandana') {
		// Tail pixels are x >= 10 (the knot and tail extending right)
		paintPixels = pixels.filter(p => p.x < 10);
	}

	// Compute bounding box
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of paintPixels) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	if (paintPixels.length === 0) {
		// No pixels to paint — clear canvas
		canvas.width = 1;
		canvas.height = 1;
		canvas.style.width = '0px';
		canvas.style.height = '0px';
		return;
	}

	const gridW = maxX - minX + 1;
	const gridH = maxY - minY + 1;
	const width = gridW * pxSize;
	const height = gridH * pxSize;
	const offsetX = -minX;
	const offsetY = -minY;

	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
		if (opts.cssScale != null) {
			canvas.style.width = `${gridW * opts.cssScale}px`;
			canvas.style.height = `${gridH * opts.cssScale}px`;
		} else {
			canvas.style.width = `${width / dpr}px`;
			canvas.style.height = `${height / dpr}px`;
		}
	}

	// Position the canvas at the correct pre-transform coordinate within
	// the 1×1px wrapper so that after scale(4) it aligns with the body sprite.
	canvas.style.position = 'absolute';
	canvas.style.left = `${minX}px`;
	canvas.style.top = `${minY}px`;

	const ctx = canvas.getContext('2d')!;
	ctx.imageSmoothingEnabled = false;
	ctx.clearRect(0, 0, width, height);

	const hueRotate = opts.hueRotate ?? 0;
	const accDef = getAccessory(accessoryId);

	for (const pixel of paintPixels) {
		const color = (hueRotate !== 0 && accDef?.id !== 'flask')
			? counterHueRotate(pixel.color, hueRotate)
			: pixel.color;
		ctx.fillStyle = color;
		ctx.fillRect(
			(pixel.x + offsetX) * pxSize,
			(pixel.y + offsetY) * pxSize,
			pxSize,
			pxSize,
		);
	}
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

	/** Eye animation timer — drives canvas repaints */
	private _eyeTimer: BobbitEyeTimer;
	/** Current eye state for repainting */
	private _eyeState: EyeState = 'center';
	/** DPR change unsubscribe */
	private _unsubDpr: (() => void) | null = null;
	/** Previous blob state — used to avoid redundant repaints in updated() */
	private _prevBlobState: string = '';

	constructor() {
		super();
		this._eyeTimer = new BobbitEyeTimer((eyeState) => {
			this._eyeState = eyeState;
			this._repaintSprite();
			this._repaintBandana();
		});
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this._unsubDpr = onDprChange(() => {
			this._repaintSprite();
			this._repaintAllAccessories();
		});
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._eyeTimer.stop();
		this._unsubDpr?.();
		this._unsubDpr = null;
	}

	/** Repaint the body+eyes sprite canvas */
	private _repaintSprite(): void {
		const canvas = this.querySelector<HTMLCanvasElement>('canvas.bobbit-blob__sprite');
		if (!canvas) return;
		drawBobbitSprite(canvas, {
			eyeState: this._eyeState,
			scale: 1,
			cssScale: 1,
		});
	}

	/** Repaint bandana canvas with tail state based on eye direction */
	private _repaintBandana(): void {
		const wrapper = this.querySelector<HTMLElement>('.bobbit-blob__bandana');
		if (!wrapper || wrapper.style.display === 'none') return;
		const canvas = wrapper.querySelector<HTMLCanvasElement>('canvas');
		if (!canvas) return;

		// Determine if tail should be hidden and translate shift
		const eyeState = this._eyeState;
		const facingRight = eyeState === 'right' || eyeState === 'blink-right';
		const lookingUp = eyeState === 'up' || eyeState === 'blink-up';
		const excludeTail = facingRight || lookingUp;

		drawAccessoryCanvas(canvas, 'bandana', { scale: 1, excludeTail, cssScale: 1 });

		// Translate shift for eyes-up state (per design doc)
		if (lookingUp) {
			wrapper.style.translate = '0 -3.5px';
		} else {
			wrapper.style.translate = '0 -2px';
		}
	}

	/** Repaint all visible accessory canvases */
	private _repaintAllAccessories(): void {
		const accessories = [
			'crown', 'bandana', 'magnifier', 'palette', 'pencil',
			'shield', 'set-square', 'flask', 'wand', 'wizard-hat',
		];
		for (const accId of accessories) {
			const wrapper = this.querySelector<HTMLElement>(`.bobbit-blob__${accId}`);
			if (!wrapper) continue;
			const canvas = wrapper.querySelector<HTMLCanvasElement>('canvas');
			if (!canvas) continue;
			if (accId === 'bandana') {
				this._repaintBandana();
			} else {
				drawAccessoryCanvas(canvas, accId, { scale: 1, cssScale: 1 });
			}
		}
	}

	/** Start/restart/stop eye timer based on blob state */
	private _updateEyeTimer(): void {
		switch (this._blobState) {
			case 'active':
			case 'entering':
				this._eyeTimer.start(BUSY_EYE_SCHEDULE, 10000);
				break;
			case 'idle':
				this._eyeTimer.start(IDLE_EYE_SCHEDULE, 10000);
				break;
			case 'exiting':
			case 'hidden':
				this._eyeTimer.stop();
				break;
			// compact-shake, compacting, compact-pop: timer keeps running
		}
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
				this._updateEyeTimer();
				this._entryTimer = setTimeout(() => {
					this._entryTimer = null;
					this._blobState = 'active';
					this._updateEyeTimer();
				}, this._entryVariant === 'enter-roll' ? 900 : 700);
			} else if (this.isStreaming) {
				this._blobState = 'active';
				this._updateEyeTimer();
			} else if (this._blobState === 'active' || this._blobState === 'entering') {
				// Streaming stopped — cancel any pending entry timer and play exit
				if (this._entryTimer) {
					clearTimeout(this._entryTimer);
					this._entryTimer = null;
				}
				this._exitVariant = Math.random() < 0.5 ? 'exit' : 'exit-roll';
				this._blobState = 'exiting';
				this._updateEyeTimer();
				setTimeout(() => {
					this._blobState = 'idle';
					this._updateEyeTimer();
				}, this._exitVariant === 'exit-roll' ? 900 : 700);
			}
		}

		// Repaint canvases only when blob state actually changed (e.g. hidden→visible)
		// The eye timer handles ongoing repaints during animation.
		if (this._blobState !== this._prevBlobState) {
			this._prevBlobState = this._blobState;
			if (this._blobVisible) {
				requestAnimationFrame(() => {
					this._repaintSprite();
					this._repaintAllAccessories();
				});
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
			this._updateEyeTimer();
			this._compactShakeTimer = setTimeout(() => {
				this._compactShakeTimer = null;
				this._blobState = 'compacting';
				this._updateEyeTimer();
			}, 800); // matches blob-compact-shake duration
		};
		if (this._blobState === 'idle') {
			this._entryVariant = Math.random() < 0.5 ? 'enter' : 'enter-roll';
			this._blobState = 'entering';
			this._updateEyeTimer();
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
		this._updateEyeTimer();
		setTimeout(() => {
			this._exitVariant = Math.random() < 0.5 ? 'exit' : 'exit-roll';
			this._blobState = 'exiting';
			this._updateEyeTimer();
			setTimeout(() => {
				this._blobState = 'idle';
				this._updateEyeTimer();
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

	/** Render the blob section with canvas elements for sprite and accessories */
	private _renderBlob() {
		return html`<div class="${this._blobClass}">
			<canvas class="bobbit-blob__sprite"></canvas>
			<div class="bobbit-blob__crown"><canvas></canvas></div>
			<div class="bobbit-blob__bandana"><canvas></canvas></div>
			<div class="bobbit-blob__magnifier"><canvas></canvas></div>
			<div class="bobbit-blob__palette"><canvas></canvas></div>
			<div class="bobbit-blob__pencil"><canvas></canvas></div>
			<div class="bobbit-blob__shield"><canvas></canvas></div>
			<div class="bobbit-blob__set-square"><canvas></canvas></div>
			<div class="bobbit-blob__flask"><canvas></canvas></div>
			<div class="bobbit-blob__wand"><canvas></canvas></div>
			<div class="bobbit-blob__wizard-hat"><canvas></canvas></div>
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
