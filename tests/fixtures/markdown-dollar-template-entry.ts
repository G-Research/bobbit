import { ensureMarkdownBlock } from "../../src/ui/lazy/markdown-block.js";

ensureMarkdownBlock();

customElements.whenDefined("markdown-block").then(() => {
	(window as any).__markdownBlockReady = true;
});
