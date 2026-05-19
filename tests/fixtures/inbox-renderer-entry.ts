// Test entry — bundles the three inbox tool renderers so we can render them
// in a file:// fixture and pin output invariants.
import { render } from "lit";
import {
	InboxListRenderer,
	InboxCompleteRenderer,
	InboxDismissRenderer,
} from "../../src/ui/tools/renderers/InboxToolRenderers.js";

function makeRenderer(kind: "list" | "complete" | "dismiss") {
	if (kind === "list") return new InboxListRenderer();
	if (kind === "complete") return new InboxCompleteRenderer();
	return new InboxDismissRenderer();
}

function renderInbox(
	containerId: string,
	kind: "list" | "complete" | "dismiss",
	params: any,
	result: any = undefined,
	isStreaming = false,
) {
	const el = document.getElementById(containerId);
	if (!el) throw new Error(`container not found: ${containerId}`);
	const r = makeRenderer(kind);
	const out = r.render(params, result, isStreaming);
	render(out.content, el);
}

function jsonResult(data: any, isError = false) {
	return {
		isError,
		content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
	};
}

(window as any).__renderInbox = renderInbox;
(window as any).__jsonResult = jsonResult;
(window as any).__ready = true;
