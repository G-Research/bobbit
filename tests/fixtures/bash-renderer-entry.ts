// Test entry — bundles BashRenderer so we can render it in a file:// fixture.
import { render } from "lit";
import { BashRenderer } from "../../src/ui/tools/renderers/BashRenderer.js";

// Minimal console-block stub — BashRenderer uses <console-block> for output.
class ConsoleBlock extends HTMLElement {
	private _content = "";
	get content() { return this._content; }
	set content(v: string) { this._content = v; this.textContent = v; }
	connectedCallback() { this.textContent = this._content; }
}
if (!customElements.get("console-block")) {
	customElements.define("console-block", ConsoleBlock);
}
class DiffBlock extends HTMLElement {
	private _content = "";
	set content(v: string) { this._content = v; this.textContent = v; }
}
if (!customElements.get("diff-block")) {
	customElements.define("diff-block", DiffBlock);
}

function renderBash(
	container: HTMLElement,
	params: { command: string; description?: string } | undefined,
	result: any = undefined,
	isStreaming = false,
) {
	const r = new BashRenderer();
	const out = r.render(params, result, isStreaming);
	render(out.content, container);
}

(window as any).__renderBash = renderBash;
(window as any).__ready = true;
