// Test entry — bundles the real <user-message> Lit component so we can render
// it in a file:// fixture and pin that it renders image tiles from the
// server-authoritative message content (WP1 / RC2 / S6).
//
// Importing Messages.js registers <user-message>; AttachmentTile.js registers
// <attachment-tile> (the tile UserMessage renders). Explicit imports make the
// custom-element side effects resilient to tree-shaking.
import "../../src/ui/components/Messages.js";
import "../../src/ui/components/AttachmentTile.js";

function renderUserMessage(container: HTMLElement, message: any) {
	container.innerHTML = "";
	const el = document.createElement("user-message") as any;
	el.message = message;
	container.appendChild(el);
}

(window as any).__renderUserMessage = renderUserMessage;
(window as any).__ready = true;
