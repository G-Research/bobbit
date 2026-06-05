import { LitElement, html } from "lit";
import { property } from "lit/decorators.js";

/**
 * A tiny element that counts up from a start time, updating every second.
 * Usage: <live-timer .startTime=${Date.now()}></live-timer>
 * Displays: "0s", "1s", "2s", ... "1m30s", etc.
 * Stops updating when `running` is set to false. When `endTime` is provided,
 * non-running timers render the fixed start-to-end duration.
 */
export class LiveTimer extends LitElement {
	@property({ type: Number }) startTime: number = Date.now();
	@property({ type: Number }) endTime: number | null = null;
	@property({ type: Boolean }) running: boolean = true;

	private _interval: ReturnType<typeof setInterval> | null = null;

	protected override createRenderRoot() {
		return this; // no shadow DOM
	}

	override connectedCallback() {
		super.connectedCallback();
		this._startInterval();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this._stopInterval();
	}

	override updated(changed: Map<string, unknown>) {
		if (changed.has("running")) {
			if (this.running) {
				this._startInterval();
			} else {
				this._stopInterval();
			}
		}
	}

	private _startInterval() {
		if (this._interval) return;
		this._interval = setInterval(() => {
			if (this.running) this.requestUpdate();
		}, 1000);
	}

	private _stopInterval() {
		if (this._interval) {
			clearInterval(this._interval);
			this._interval = null;
		}
	}

	override render() {
		const referenceTime = !this.running && typeof this.endTime === "number" && Number.isFinite(this.endTime)
			? this.endTime
			: Date.now();
		const elapsed = Math.max(0, Math.round((referenceTime - this.startTime) / 1000));
		if (!Number.isFinite(elapsed)) return html`—`;
		const display = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, '0')}s`;
		return html`${display}`;
	}
}

customElements.define("live-timer", LiveTimer);
