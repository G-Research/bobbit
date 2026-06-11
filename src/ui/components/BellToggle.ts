/**
 * <bell-toggle> — header button that toggles the agent-finish beep on/off,
 * mirroring the Settings "Play a short notification beep…" preference. Sits next
 * to <theme-toggle> and matches its ghost-icon styling. Shows a Bell when beeps
 * are on and a BellOff (bell with a line through it) when muted.
 */
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Bell, BellOff } from "lucide";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { PLAY_FINISH_SOUND_CHANGED, isPlayFinishSoundEnabled, setPlayFinishSoundEnabled } from "../../app/play-finish-sound.js";

@customElement("bell-toggle")
export class BellToggle extends LitElement {
	@state() private _enabled = true;

	/** Re-read the shared dataset when the preference changes on any surface
	 * (this button, the Settings checkbox, or a `preferences_changed` broadcast). */
	private _onChange = () => { this._enabled = isPlayFinishSoundEnabled(); };

	// Light DOM so it inherits app styles (matches <theme-toggle>).
	override createRenderRoot() { return this; }

	override connectedCallback() {
		super.connectedCallback();
		this._enabled = isPlayFinishSoundEnabled();
		window.addEventListener(PLAY_FINISH_SOUND_CHANGED, this._onChange);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		window.removeEventListener(PLAY_FINISH_SOUND_CHANGED, this._onChange);
	}

	private _toggle() {
		const next = !this._enabled;
		this._enabled = next; // optimistic
		void setPlayFinishSoundEnabled(next);
	}

	override render() {
		return html`${Button({
			variant: "ghost",
			size: "icon",
			onClick: () => this._toggle(),
			title: this._enabled ? "Mute agent finish beeps" : "Unmute agent finish beeps",
			children: icon(this._enabled ? Bell : BellOff, "md"),
		})}`;
	}
}
