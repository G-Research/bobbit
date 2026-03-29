import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";

@customElement("markdown-web-content")
export class MarkdownWebContent extends LitElement {
	@property() content = "";
	@state() private mode: "preview" | "raw" = "preview";

	createRenderRoot() {
		return this;
	}

	render() {
		return html`
			<div class="flex justify-end mb-1 gap-1">
				<button
					@click=${() => (this.mode = "preview")}
					class="text-xs px-2 py-0.5 rounded ${this.mode === "preview"
						? "text-foreground bg-muted"
						: "text-muted-foreground hover:text-foreground"}"
				>
					Preview
				</button>
				<button
					@click=${() => (this.mode = "raw")}
					class="text-xs px-2 py-0.5 rounded ${this.mode === "raw"
						? "text-foreground bg-muted"
						: "text-muted-foreground hover:text-foreground"}"
				>
					Raw
				</button>
			</div>
			${this.mode === "preview"
				? html`<markdown-block .content=${this.content}></markdown-block>`
				: html`<code-block .code=${this.content} language="markdown"></code-block>`}
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"markdown-web-content": MarkdownWebContent;
	}
}
