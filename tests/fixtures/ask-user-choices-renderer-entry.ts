// Test entry — bundles AskUserChoicesRenderer so we can render it in a file:// fixture.
//
// The renderer imports `AskUserChoicesWidget` for its custom-element side effect
// (auto-registers <ask-user-choices-widget>). The explicit import below makes
// that intent visible and resilient to tree-shaking.
import { render } from "lit";
import { AskUserChoicesRenderer } from "../../src/ui/tools/renderers/AskUserChoicesRenderer.js";
import "../../src/ui/components/AskUserChoicesWidget.js";

function renderAsk(
	container: HTMLElement,
	params: any,
	result: any = undefined,
	isStreaming = false,
) {
	const r = new AskUserChoicesRenderer();
	// ctx is undefined — the fixture does not exercise the envelope-answer
	// lookup path; only the renderer's gating between interactive / posted-stub /
	// error states.
	const out = r.render(params, result, isStreaming, undefined);
	render(out.content, container);
}

(window as any).__renderAsk = renderAsk;
(window as any).__ready = true;
