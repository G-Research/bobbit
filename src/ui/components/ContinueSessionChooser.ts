/**
 * <continue-session-chooser> — Modal shown when the user clicks
 * "Continue in New Session" on an archived session. Lets them pick between a
 * summary of the prior session or the full verbatim transcript as seed
 * context, then emits a `continue` event with `{ mode }` (or `cancel`).
 *
 * Light DOM so inherited CSS (Tailwind-like utility classes + CSS vars)
 * applies. The modal manages its own backdrop + Escape-to-close behaviour.
 */
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

/**
 * Same threshold as the server-side `LARGE_CONTENT_THRESHOLD` in
 * `src/server/agent/truncate-large-content.ts`. Duplicated here because this
 * file is shipped to the browser and must not pull in server modules.
 */
const LARGE_CONTENT_THRESHOLD = 32 * 1024;

export type ContinueMode = "summary" | "full";

/**
 * Estimate the serialised size of the archived transcript so we can warn the
 * user that Full mode will be truncated. Best-effort: treats messages as JSON
 * because that mirrors what ends up on disk.
 */
export function estimateTranscriptBytes(sessionState: any): number {
	const messages: unknown[] = sessionState?.messages ?? [];
	if (!Array.isArray(messages) || messages.length === 0) return 0;
	let total = 0;
	for (const m of messages) {
		try {
			total += JSON.stringify(m).length;
		} catch {
			// Circular / unserialisable — skip
		}
	}
	return total;
}

@customElement("continue-session-chooser")
export class ContinueSessionChooser extends LitElement {
	/** The archived session being continued. Used for display only. */
	@property() sessionId = "";
	/** Rough message count shown in the modal chrome. */
	@property({ type: Number }) messageCount = 0;
	/** Estimated serialised transcript size, used to show the truncation warning. */
	@property({ type: Number }) transcriptBytes = 0;

	@state() private _mode: ContinueMode = "summary";

	private _boundKeyDown = this._onKeyDown.bind(this);

	override createRenderRoot() {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		// The custom element must have non-zero layout for Playwright's
		// visibility heuristic (zero-size elements are treated as hidden).
		this.style.position = "fixed";
		this.style.inset = "0";
		this.style.zIndex = "50";
		document.addEventListener("keydown", this._boundKeyDown);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("keydown", this._boundKeyDown);
	}

	private _onKeyDown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			this._cancel();
		}
	}

	private _cancel = () => {
		this.dispatchEvent(new CustomEvent("cancel", { bubbles: false }));
	};

	private _confirm = () => {
		this.dispatchEvent(
			new CustomEvent("continue", {
				bubbles: false,
				detail: { mode: this._mode },
			}),
		);
	};

	private _selectMode(mode: ContinueMode) {
		this._mode = mode;
		this.requestUpdate();
	}

	override render() {
		const isLarge = this.transcriptBytes >= LARGE_CONTENT_THRESHOLD;
		const transcriptKb = Math.round(this.transcriptBytes / 1024);

		const card = (mode: ContinueMode, title: string, body: string) => {
			const selected = this._mode === mode;
			return html`
				<button
					type="button"
					role="radio"
					aria-checked=${selected}
					data-mode=${mode}
					class="text-left w-full rounded-md border p-3 transition-colors hover:bg-muted cursor-pointer"
					style="border-color: ${selected ? "var(--primary, #3b82f6)" : "var(--border)"}; background: ${selected ? "var(--muted, transparent)" : "transparent"};"
					@click=${() => this._selectMode(mode)}
				>
					<div class="flex items-start gap-2">
						<span
							aria-hidden="true"
							style="display:inline-block;width:14px;height:14px;border-radius:9999px;border:2px solid ${selected ? "var(--primary, #3b82f6)" : "var(--muted-foreground, #71717a)"};flex-shrink:0;margin-top:2px;position:relative;"
						>
							${selected
								? html`<span
										style="position:absolute;inset:2px;border-radius:9999px;background:var(--primary, #3b82f6);"
									></span>`
								: nothing}
						</span>
						<div class="flex flex-col gap-1 min-w-0">
							<div class="text-sm font-medium text-foreground">${title}</div>
							<div class="text-xs text-muted-foreground">${body}</div>
						</div>
					</div>
				</button>
			`;
		};

		return html`
			<div
				class="fixed inset-0 z-50 flex items-center justify-center p-4"
				style="background: rgba(0,0,0,0.55);"
				data-continue-chooser-backdrop
				@click=${(e: MouseEvent) => {
					if (e.target === e.currentTarget) this._cancel();
				}}
			>
				<div
					role="dialog"
					aria-modal="true"
					aria-label="Continue in new session"
					class="bg-background text-foreground rounded-lg shadow-xl w-full"
					style="max-width: 520px; border:1px solid var(--border);"
				>
					<div class="flex flex-col gap-3 p-5">
						<div class="flex flex-col gap-1">
							<h2 class="text-base font-semibold">Continue in new session</h2>
							<p class="text-xs text-muted-foreground">
								Start a fresh session configured like this one. How should we
								seed the history?
							</p>
						</div>

						<div
							class="flex flex-col gap-2"
							role="radiogroup"
							aria-label="Seed mode"
						>
							${card(
								"summary",
								"Summary",
								"Short recap of this session, generated by a small model.",
							)}
							${card(
								"full",
								"Full transcript",
								"Verbatim history from this session.",
							)}
						</div>

						${this._mode === "full" && isLarge
							? html`
								<div
									class="text-xs rounded-md px-3 py-2"
									style="background: var(--muted, #27272a); color: var(--muted-foreground, #a1a1aa); border:1px solid var(--border);"
									data-large-transcript-warning
								>
									This transcript is large (~${transcriptKb} KB) and will be
									truncated per the large-content policy.
								</div>
							`
							: nothing}

						<div class="flex items-center justify-end gap-2 pt-1">
							<button
								type="button"
								class="px-3 py-1.5 text-sm rounded-md border hover:bg-muted"
								style="border-color: var(--border);"
								data-action="cancel"
								@click=${this._cancel}
							>
								Cancel
							</button>
							<button
								type="button"
								class="px-3 py-1.5 text-sm rounded-md text-white"
								style="background: var(--primary, #3b82f6); border:1px solid var(--primary, #3b82f6);"
								data-action="continue"
								@click=${this._confirm}
							>
								Continue
							</button>
						</div>
					</div>
				</div>
			</div>
		`;
	}
}

if (!customElements.get("continue-session-chooser")) {
	customElements.define("continue-session-chooser", ContinueSessionChooser);
}
