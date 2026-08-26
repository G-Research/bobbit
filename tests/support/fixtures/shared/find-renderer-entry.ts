// Test entry — bundles FindRenderer so we can render it in a file:// fixture.
//
// This fixture gives tests/dom/ui-fixtures/find-tool.dom.test.ts a fully
// deterministic surface to assert
// against. The bundled fd/rg work guarantees binaries are available; the
// renderer is the visible contract the user sees when the tool fires.
import { render } from "lit";
import { FindRenderer } from "../../../../src/ui/tools/renderers/FindRenderer.js";

// Minimal <console-block> stub — FindRenderer renders results into one.
class ConsoleBlock extends HTMLElement {
	private _content = "";
	get content() { return this._content; }
	set content(v: string) { this._content = v; this.textContent = v; }
	connectedCallback() { this.textContent = this._content; }
}
if (!customElements.get("console-block")) {
	customElements.define("console-block", ConsoleBlock);
}

function renderFind(
	container: HTMLElement,
	params: { pattern: string; path?: string; limit?: number } | undefined,
	result: any = undefined,
	isStreaming = false,
) {
	const r = new FindRenderer();
	const out = r.render(params, result, isStreaming);
	render(out.content, container);
}

(window as any).__renderFind = renderFind;
(window as any).__ready = true;
