import { html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";

/**
 * Dismissable error message displayed inline in the chat history.
 * Rendered when a server/agent error occurs (e.g. failed prompt,
 * RPC timeout, model doesn't support vision, etc.).
 */
export class ErrorMessage extends LitElement {
	@property({ type: Object }) message!: { role: "error"; content: string; code?: string; timestamp: number; id: string };
	@property({ attribute: false }) onDismiss?: (id: string) => void;
	@property({ attribute: false }) onRestartAgent?: () => void;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private get _isAgentProcessError(): boolean {
		return !!this.message.content?.includes("Agent process not running");
	}

	override render() {
		return html`
			<div class="mx-4 my-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-start gap-3">
				<svg class="w-5 h-5 text-destructive shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
				</svg>
				<div class="flex-1 min-w-0">
					<div class="text-sm text-destructive font-medium">Error</div>
					<div class="text-sm text-destructive/80 mt-0.5 break-words">${this.message.content}</div>
					${this.message.code ? html`<div class="text-xs text-destructive/50 mt-1 font-mono">${this.message.code}</div>` : ""}
					${this._isAgentProcessError ? html`
						<button
							class="mt-2 px-3 py-1.5 text-xs font-medium rounded-md bg-destructive/15 hover:bg-destructive/25 text-destructive border border-destructive/20 transition-colors"
							@click=${this._handleRestart}
						>
							Restart Agent
						</button>
					` : nothing}
				</div>
				<button
					class="shrink-0 p-1 rounded hover:bg-destructive/10 text-destructive/60 hover:text-destructive transition-colors"
					title="Dismiss"
					@click=${() => this.onDismiss?.(this.message.id)}
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
		`;
	}

	private _handleRestart(): void {
		this.onRestartAgent?.();
		this.onDismiss?.(this.message.id);
	}
}

if (!customElements.get("error-message")) {
	customElements.define("error-message", ErrorMessage);
}
