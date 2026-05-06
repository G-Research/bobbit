import { html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";

/**
 * Shared error display used inside dialogs/modals. Renders a readable
 * description, optional muted error code, and an optional collapsible
 * stack-trace disclosure.
 *
 * Light-DOM (createRenderRoot returns `this`) so Tailwind classes work.
 *
 * Wire-up surface (per the symlink + error UX hardening design): every
 * modal/dialog that previously surfaced only a server error string. NOT used
 * in chat-transcript banners, REST-error toasts, or tool-result renderers.
 */
export class ErrorDetails extends LitElement {
	@property() message = "";
	@property() code?: string;
	@property() stack?: string;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override render() {
		return html`
			<div class="text-sm text-destructive font-medium" data-testid="error-details-message">${this.message}</div>
			${this.code
				? html`<div class="text-xs text-destructive/60 mt-1 font-mono" data-testid="error-details-code">${this.code}</div>`
				: nothing}
			${this.stack
				? html`
					<details class="mt-2" data-testid="error-details-stack">
						<summary class="cursor-pointer text-xs text-muted-foreground">Show stack trace</summary>
						<pre class="mt-1 p-2 text-[11px] bg-muted/40 rounded overflow-x-auto whitespace-pre-wrap font-mono">${this.stack}</pre>
					</details>
				`
				: nothing}
		`;
	}
}

if (!customElements.get("error-details")) {
	customElements.define("error-details", ErrorDetails);
}
