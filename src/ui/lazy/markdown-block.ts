// Lazy loader for the heavy <markdown-block> custom element.
//
// The element is registered as a side-effect of importing
// `@mariozechner/mini-lit/dist/MarkdownBlock.js`, which transitively
// pulls in KaTeX, marked, highlight.js — together ~150 kB gzipped.
// Importing it eagerly anywhere forces that graph into the main chunk.
//
// Call `ensureMarkdownBlock()` from any renderer or component that
// emits a `<markdown-block>` tag (in `render()` or the constructor).
// The first call kicks off the dynamic import; subsequent calls are
// no-ops. The custom element upgrades asynchronously when the chunk
// lands — Lit re-renders the host fine, and a brief flash of unstyled
// text on first encounter is acceptable.

let loaded = false;

export function ensureMarkdownBlock(): void {
	if (loaded) return;
	loaded = true;
	import("@mariozechner/mini-lit/dist/MarkdownBlock.js");
}
