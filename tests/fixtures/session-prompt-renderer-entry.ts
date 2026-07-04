// Test entry — bundles SessionPromptRenderer so a file:// fixture can mount it.
import { render } from "lit";
import { SessionPromptRenderer } from "../../src/ui/tools/renderers/SessionPromptRenderer.js";

function renderSessionPrompt(
	container: HTMLElement,
	params: any,
	result: any = undefined,
	isStreaming = false,
	ctx: any = {},
) {
	const renderer = new SessionPromptRenderer();
	const out = renderer.render(params, result, isStreaming, ctx);
	render(out.content, container);
}

(window as any).__renderSessionPrompt = renderSessionPrompt;
(window as any).__ready = true;
