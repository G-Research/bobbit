// Lazy loader for the heavy <gate-verification-live> custom element.
//
// The module pulls in MarkdownBlock + KaTeX + ANSI helpers, so importing it
// eagerly anywhere forces that graph into the main chunk. Call this from any
// renderer that emits a `<gate-verification-live>` tag — the first call kicks
// off the dynamic import; subsequent calls are no-ops. Lit re-renders the host
// fine when the custom element upgrades asynchronously.

let loaded = false;

export function ensureGateVerificationLive(): void {
	if (loaded) return;
	loaded = true;
	import("../tools/renderers/GateVerificationLive.js");
}
